import { randomUUID } from "node:crypto";
import type { JsonValue } from "../../src/orchestrator/contracts/event.js";
import type { ProjectContext } from "../../src/orchestrator/identity/contracts.js";
import {
  parseTrustedProjectBindingRequest,
  type TrustedProjectBindingRequest,
} from "../../src/orchestrator/identity/project-binding.request.js";
import { ProjectBindingService } from "../../src/orchestrator/identity/project-binding.service.js";
import { WorkerProjectStoreIdentityProbe } from "../../src/orchestrator/runtime/project-store-identity-probe.js";
import { ProjectStoreWorkerBackend } from "../../src/orchestrator/runtime/project-store-worker-backend.js";
import {
  decodeWorkerBinding,
  encodeWorkerBinding,
  encodeWorkerBindingAssertion,
  type AppendCommandWire,
  type AppendResultWire,
  type ProjectStoreRouteWire,
  type StoreIdentityWire,
  type WorkerBinding,
} from "../../src/orchestrator/runtime/worker-protocol.js";
import { BranchScopeRepository } from "../../src/orchestrator/storage/branch-scope.repository.js";
import {
  EventStore,
  SqliteEventStoreStatements,
  type EventStoreFaultBoundary,
  type EventStoreFaultContext,
  type EventStoreFaultInjector,
} from "../../src/orchestrator/storage/event-store.js";
import { DefaultProjectStoreBootstrapService } from "../../src/orchestrator/storage/project-store-bootstrap.service.js";

const WORKER_URL = new URL("../../src/workers/project-store.worker.js", import.meta.url);
const childId = randomUUID();
const requestedBoundary = process.argv[2];
const BOUNDARIES = new Set<EventStoreFaultBoundary>([
  "before-begin",
  "after-first-insert-before-commit",
  "after-commit-before-response",
]);

type FixtureStartAction =
  | {
      kind: "initialize";
      request: TrustedProjectBindingRequest;
      replicaDecision?: "initialize-local";
    }
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

let context: ProjectContext | undefined;
let backend: ProjectStoreWorkerBackend | undefined;
let started = false;
let closing = false;
let queue = Promise.resolve();

function send(message: ChildMessage): void {
  if (process.send === undefined) throw new Error("IPC_UNAVAILABLE");
  process.send(message);
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : error instanceof Error && error.message.length > 0
      ? error.message
      : "FIXTURE_ERROR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : errorCode(error);
}

function boundary(): EventStoreFaultBoundary {
  if (typeof requestedBoundary !== "string" || !BOUNDARIES.has(requestedBoundary as EventStoreFaultBoundary)) {
    const failure = new Error("FAULT_BOUNDARY_INVALID") as Error & { code: string };
    failure.code = "FAULT_BOUNDARY_INVALID";
    throw failure;
  }
  return requestedBoundary as EventStoreFaultBoundary;
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

function createBackend(faultBoundary: EventStoreFaultBoundary): ProjectStoreWorkerBackend {
  const faultInjector: EventStoreFaultInjector = {
    hit(observed: EventStoreFaultBoundary, _context: EventStoreFaultContext): void {
      if (observed === faultBoundary) process.exit(137);
    },
  };
  return new ProjectStoreWorkerBackend({
    selfUrl: WORKER_URL,
    executorLeaseMs: 20_000,
    appendRetryDeadlineMs: 10_000,
    eventStoreFactory(connection, maintenance) {
      return new EventStore(
        connection,
        new SqliteEventStoreStatements(connection),
        maintenance,
        new BranchScopeRepository(),
        undefined,
        undefined,
        faultInjector,
      );
    },
  });
}

async function openBackend(activeContext: ProjectContext): Promise<{ identity: StoreIdentityWire; executorId: string }> {
  backend = createBackend(boundary());
  const opened = await backend.dispatch({
    id: randomUUID(),
    type: "open",
    binding: encodeWorkerBinding(activeContext),
  });
  if (!("executorId" in opened)) throw new Error("WORKER_PROTOCOL_ERROR");
  return {
    identity: {
      projectId: opened.projectId,
      vaultId: opened.vaultId,
      storeId: opened.storeId,
    },
    executorId: opened.executorId,
  };
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
    await openBackend(context);
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
  context = decodeWorkerBinding(action.binding);
  if (action.route.eventsPath !== context.binding.storeRoute.eventsPath) {
    throw new Error("STORE_ROUTE_INVALID");
  }
  const opened = await openBackend(context);
  started = true;
  send({ type: "started", childId, result: { kind: "opened", ...opened } });
}

async function append(command: AppendCommandWire): Promise<void> {
  if (!started || context === undefined || backend === undefined || closing) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  const result = await backend.dispatch({
    id: randomUUID(),
    type: "append",
    binding: encodeWorkerBindingAssertion(context),
    command,
  });
  send({
    type: "result",
    commandId: command.commandId,
    result: result as AppendResultWire,
  });
}

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await backend?.close();
  send({ type: "closed", childId });
  process.disconnect?.();
}

async function handle(message: unknown): Promise<void> {
  if (typeof message !== "object" || message === null || !("type" in message)) {
    throw new Error("FIXTURE_PROTOCOL_ERROR");
  }
  const observed = message as ParentMessage;
  if (observed.type === "start") {
    try { await start(observed.action); } catch (error) {
      send({ type: "error", code: errorCode(error), message: errorMessage(error) });
    }
    return;
  }
  if (observed.type === "append") {
    try { await append(observed.command); } catch (error) {
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
  if (!closing) void backend?.close().finally(() => { process.exitCode = 1; });
});

send({ type: "ready", childId });
