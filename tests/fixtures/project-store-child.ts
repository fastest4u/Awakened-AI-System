import { randomUUID } from "node:crypto";
import type { ProjectContext } from "../../src/orchestrator/identity/contracts.js";
import {
  parseTrustedProjectBindingRequest,
  type TrustedProjectBindingRequest,
} from "../../src/orchestrator/identity/project-binding.request.js";
import { ProjectBindingService } from "../../src/orchestrator/identity/project-binding.service.js";
import { WorkerProjectStoreIdentityProbe } from "../../src/orchestrator/runtime/project-store-identity-probe.js";
import {
  DEFAULT_MAX_PENDING,
  ProjectStoreExecutor,
} from "../../src/orchestrator/runtime/project-store-executor.js";
import { inspectProjectStoreIdentity } from "../../src/orchestrator/runtime/project-store-worker-backend.js";
import {
  decodeAppendCommandWire,
  decodeWorkerBinding,
  encodeAppendResultWire,
  type AppendCommandWire,
  type AppendResultWire,
  type ProjectStoreRouteWire,
  type StoreIdentityWire,
  type WorkerBinding,
} from "../../src/orchestrator/runtime/worker-protocol.js";
import { DefaultProjectStoreBootstrapService } from "../../src/orchestrator/storage/project-store-bootstrap.service.js";

const WORKER_URL = new URL("../../src/workers/project-store.worker.js", import.meta.url);
const childId = randomUUID();

type FixtureStartAction =
  | {
      kind: "initialize";
      request: TrustedProjectBindingRequest;
      replicaDecision?: "initialize-local";
    }
  | {
      kind: "open";
      route: ProjectStoreRouteWire;
      binding: WorkerBinding;
    };

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

let context: ProjectContext | undefined;
let executor: ProjectStoreExecutor | undefined;
let started = false;
let closing = false;
let queue = Promise.resolve();

function send(message: ChildMessage): void {
  if (process.send === undefined) throw new Error("IPC_UNAVAILABLE");
  process.send(message);
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error
    && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return error instanceof Error && error.message.length > 0 ? error.message : "FIXTURE_ERROR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : errorCode(error);
}

async function establish(request: TrustedProjectBindingRequest): Promise<ProjectContext> {
  const service = new ProjectBindingService({
    identityProbe: new WorkerProjectStoreIdentityProbe({ workerUrl: WORKER_URL }),
  });
  const resolution = await service.establish(request);
  if (!resolution.ok) {
    const failure = new Error(resolution.message) as Error & { code: string };
    failure.code = resolution.code;
    throw failure;
  }
  return {
    binding: resolution.binding,
    workspace: resolution.binding.workspace,
    checkedAt: new Date().toISOString(),
  };
}

function createExecutor(activeContext: ProjectContext): ProjectStoreExecutor {
  return new ProjectStoreExecutor({
    workerUrl: WORKER_URL,
    context: activeContext,
    maxPending: DEFAULT_MAX_PENDING,
    requestTimeoutMs: 20_000,
    closeTimeoutMs: 10_000,
    executorLeaseMs: 20_000,
    heartbeatIntervalMs: 5_000,
  });
}

async function start(action: FixtureStartAction): Promise<void> {
  if (started || closing) throw new Error("FIXTURE_PROTOCOL_ERROR");
  if (action.kind === "initialize") {
    const request = parseTrustedProjectBindingRequest(action.request as unknown as Record<string, unknown>);
    const initialized = await new DefaultProjectStoreBootstrapService().initialize({
      projectRoot: request.projectRoot,
      vaultRoot: request.vaultRoot,
      ...(action.replicaDecision === undefined ? {} : { replicaDecision: action.replicaDecision }),
    });
    context = await establish(request);
    executor = createExecutor(context);
    await executor.open();
    started = true;
    send({
      type: "started",
      childId,
      result: {
        kind: "initialized",
        route: initialized.route,
        createdDescriptor: initialized.createdDescriptor,
        createdStore: initialized.createdStore,
        recoveredManifest: initialized.recoveredManifest,
      },
    });
    return;
  }

  const decoded = decodeWorkerBinding(action.binding);
  await inspectProjectStoreIdentity(action.route, {
    projectId: decoded.binding.projectId,
    vaultId: decoded.binding.vaultId,
  }, decoded.binding.storeId);
  if (
    action.route.kind !== decoded.binding.storeRoute.kind
    || action.route.storeRoot !== decoded.binding.storeRoute.storeRoot
    || action.route.eventsPath !== decoded.binding.storeRoute.eventsPath
    || action.route.storeManifestPath !== decoded.binding.storeRoute.storeManifestPath
    || action.route.projectionManifestPath !== decoded.binding.storeRoute.projectionManifestPath
  ) {
    const failure = new Error("STORE_ROUTE_INVALID") as Error & { code: string };
    failure.code = "STORE_ROUTE_INVALID";
    throw failure;
  }
  context = decoded;
  executor = createExecutor(context);
  const opened = await executor.open();
  started = true;
  send({
    type: "started",
    childId,
    result: {
      kind: "opened",
      identity: {
        projectId: opened.projectId,
        vaultId: opened.vaultId,
        storeId: opened.storeId,
      },
      executorId: opened.executorId,
    },
  });
}

async function append(commandWire: AppendCommandWire): Promise<void> {
  if (!started || context === undefined || executor === undefined || closing) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  const command = decodeAppendCommandWire(commandWire, context);
  const result = await executor.append(command);
  send({
    type: "result",
    commandId: commandWire.commandId,
    result: encodeAppendResultWire(result),
  });
}

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await executor?.close();
  send({ type: "closed", childId });
  process.disconnect?.();
}

async function handle(message: unknown): Promise<void> {
  if (typeof message !== "object" || message === null || !("type" in message)) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  const observed = message as ParentMessage;
  if (observed.type === "start") {
    try {
      await start(observed.action);
    } catch (error) {
      send({ type: "error", code: errorCode(error), message: errorMessage(error) });
    }
    return;
  }
  if (observed.type === "append") {
    try {
      await append(observed.command);
    } catch (error) {
      send({
        type: "error",
        commandId: observed.command.commandId,
        code: errorCode(error),
        message: errorMessage(error),
      });
    }
    return;
  }
  if (observed.type === "close") {
    await close();
    return;
  }
  throw new Error("FIXTURE_PROTOCOL_ERROR");
}

process.on("message", (message: unknown) => {
  queue = queue.then(() => handle(message)).catch((error: unknown) => {
    send({ type: "error", code: errorCode(error), message: errorMessage(error) });
  });
});

process.on("disconnect", () => {
  if (!closing) void executor?.close().finally(() => { process.exitCode = 1; });
});

send({ type: "ready", childId });
