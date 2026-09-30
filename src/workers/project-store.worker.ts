import { parentPort, workerData } from "node:worker_threads";
import { inspectV2Build } from "../v2/build-identity.js";
import {
  ProjectStoreWorkerBackend,
  ProjectStoreWorkerBackendError,
  runIntegrityChild,
} from "../orchestrator/runtime/project-store-worker-backend.js";
import { ProjectStoreUpgradeService } from "../orchestrator/storage/project-store-upgrade.service.js";
import {
  ProjectStoreWorkerRuntime,
  type WorkerRuntimePort,
  type WorkerRuntimeScheduler,
} from "../orchestrator/runtime/project-store-worker-runtime.js";
import {
  decodeWorkerBinding,
  decodeIntegrityProviderResponseWire,
  decodeWorkerRequest,
  decodeUpgradeWorkerCommand,
  decodeMaintenanceLeaseWire,
  encodeMaintenanceLeaseWire,
  type WorkerRequest,
} from "../orchestrator/runtime/worker-protocol.js";
import { WorkerIntegrityProviderClient } from "../orchestrator/runtime/worker-integrity-provider-client.js";
import type { MaintenanceLease } from "../orchestrator/storage/maintenance-fence.js";

const DEFAULT_EXECUTOR_LEASE_MS = 15_000;
const DEFAULT_APPEND_RETRY_DEADLINE_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

type WorkerRoleConfig =
  | {
      role: "store";
      executorLeaseMs: number;
      heartbeatIntervalMs: number;
      appendRetryDeadlineMs: number;
    }
  | { role: "identity" }
  | { role: "integrity"; binding: unknown }
  | { role: "upgrade"; binding: unknown; trustedTtlMs?: number };

function protocolFailure(): never {
  throw new ProjectStoreWorkerBackendError("WORKER_CONFIG_INVALID");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) protocolFailure();
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const observed = record(value);
  const actual = Object.keys(observed).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    protocolFailure();
  }
  return observed;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) protocolFailure();
  return Number(value);
}

function config(value: unknown): WorkerRoleConfig {
  const observed = record(value);
  if (observed.role === "identity") {
    exact(value, ["role"]);
    return { role: "identity" };
  }
  if (observed.role === "integrity") {
    const parsed = exact(value, ["role", "binding"]);
    return { role: "integrity", binding: parsed.binding };
  }
  if (observed.role === "upgrade") {
    const keys = Object.keys(observed).sort();
    const expected = observed.trustedTtlMs === undefined
      ? ["binding", "role"]
      : ["binding", "role", "trustedTtlMs"];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      protocolFailure();
    }
    return {
      role: "upgrade",
      binding: observed.binding,
      ...(observed.trustedTtlMs === undefined
        ? {}
        : { trustedTtlMs: positiveInteger(observed.trustedTtlMs) }),
    };
  }
  if (observed.role === "store") {
    const parsed = exact(value, [
      "role", "executorLeaseMs", "heartbeatIntervalMs", "appendRetryDeadlineMs",
    ]);
    const executorLeaseMs = positiveInteger(parsed.executorLeaseMs);
    const heartbeatIntervalMs = positiveInteger(parsed.heartbeatIntervalMs);
    const appendRetryDeadlineMs = positiveInteger(parsed.appendRetryDeadlineMs);
    if (heartbeatIntervalMs >= executorLeaseMs) protocolFailure();
    return { role: "store", executorLeaseMs, heartbeatIntervalMs, appendRetryDeadlineMs };
  }
  protocolFailure();
}

function safeFailure(error: unknown): { code: string; details: Record<string, string | number | boolean | null> } {
  if (typeof error !== "object" || error === null) return { code: "STORE_UNAVAILABLE", details: {} };
  const code = "code" in error && typeof error.code === "string"
    && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code
    : "STORE_UNAVAILABLE";
  const details: Record<string, string | number | boolean | null> = {};
  if ("details" in error && typeof error.details === "object" && error.details !== null) {
    for (const [key, item] of Object.entries(error.details as Record<string, unknown>)) {
      if (
        item === null
        || typeof item === "string"
        || typeof item === "boolean"
        || (typeof item === "number" && Number.isFinite(item))
      ) details[key] = item;
    }
  }
  return { code, details };
}

if (parentPort === null) throw new Error("WORKER_PARENT_PORT_REQUIRED");
const parent = parentPort;

const role = config(workerData);
const selfUrl = new URL(import.meta.url);
const upgradePhaseWorkerUrl = new URL("./project-store-upgrade-phase.worker.js", import.meta.url);

if (role.role === "upgrade") {
  const context = decodeWorkerBinding(role.binding);
  let activeOperationId: string | null = null;
  let releaseQuiesce: (() => void) | null = null;
  let rejectQuiesce: ((error: Error) => void) | null = null;
  let activeService: ProjectStoreUpgradeService | null = null;
  const registry = {
    quiesceStore(
      _context: typeof context,
      lease: MaintenanceLease,
    ): Promise<void> {
      if (activeOperationId === null || releaseQuiesce !== null) {
        throw new ProjectStoreWorkerBackendError("WORKER_PROTOCOL_ERROR");
      }
      parent.postMessage({
        type: "upgrade-quiesce-required",
        operationId: activeOperationId,
        lease: encodeMaintenanceLeaseWire(lease),
      });
      return new Promise<void>((resolveQuiesce, reject) => {
        releaseQuiesce = resolveQuiesce;
        rejectQuiesce = reject;
      });
    },
  };
  const postFailure = (id: string, error: unknown): void => {
    const failure = safeFailure(error);
    parent.postMessage({
      id,
      ok: false,
      error: { code: failure.code, message: failure.code, details: failure.details },
    });
  };
  parent.on("message", (value: unknown) => {
    let command: ReturnType<typeof decodeUpgradeWorkerCommand>;
    try {
      command = decodeUpgradeWorkerCommand(value);
    } catch (error) {
      postFailure("unknown", error);
      return;
    }
    if (command.type === "upgrade-quiesce-complete") {
      if (command.operationId !== activeOperationId || releaseQuiesce === null) {
        postFailure("unknown", new ProjectStoreWorkerBackendError("WORKER_PROTOCOL_ERROR"));
        return;
      }
      const release = releaseQuiesce;
      releaseQuiesce = null;
      rejectQuiesce = null;
      release();
      return;
    }
    if (command.type === "upgrade-confirm-closure") {
      if (command.operationId !== activeOperationId || activeService === null) {
        postFailure(command.id, new ProjectStoreWorkerBackendError("MAINTENANCE_CONFIRMATION_FAILED"));
        return;
      }
      const lease = decodeMaintenanceLeaseWire(command.confirmation.lease);
      void activeService.confirmMaintenanceClosure({
        projectId: command.confirmation.projectId as typeof context.binding.projectId,
        executorId: command.confirmation.executorId,
        lease,
        connectionClosed: true,
      }).then(() => {
        parent.postMessage({ id: command.id, ok: true, data: { confirmed: true } });
      }).catch((error: unknown) => postFailure(command.id, error));
      return;
    }
    if (command.type === "upgrade-inspect") {
      if (activeOperationId !== null) {
        postFailure(command.id, new ProjectStoreWorkerBackendError("MAINTENANCE_ALREADY_ACTIVE"));
        return;
      }
      const service = new ProjectStoreUpgradeService();
      void service.inspect(context).then((plan) => {
        parent.postMessage({ id: command.id, ok: true, data: plan });
      }).catch((error: unknown) => postFailure(command.id, error));
      return;
    }
    if (activeOperationId !== null) {
      postFailure(command.id, new ProjectStoreWorkerBackendError("MAINTENANCE_ALREADY_ACTIVE"));
      return;
    }
    activeOperationId = command.id;
    activeService = new ProjectStoreUpgradeService({
      executorRegistry: registry,
      upgradePhaseWorkerUrl,
      ...(role.trustedTtlMs === undefined ? {} : { trustedTtlMs: role.trustedTtlMs }),
    });
    void activeService.apply(context).then((result) => {
      parent.postMessage({ id: command.id, ok: true, data: result });
    }).catch((error: unknown) => postFailure(command.id, error)).finally(() => {
      if (releaseQuiesce !== null) {
        const reject = rejectQuiesce;
        releaseQuiesce = null;
        rejectQuiesce = null;
        reject?.(new ProjectStoreWorkerBackendError("WORKER_CLOSED"));
      }
      activeOperationId = null;
      activeService = null;
    });
  });
} else if (role.role === "integrity") {
  const context = decodeWorkerBinding(role.binding);
  let accepted = false;
  let activeRequestId = "unknown";
  let providerClient: WorkerIntegrityProviderClient | null = null;
  let terminalPosted = false;
  const postFailureOnce = (id: string, error: unknown): void => {
    if (terminalPosted) return;
    terminalPosted = true;
    const failure = safeFailure(error);
    parent.postMessage({
      id,
      ok: false,
      error: { code: failure.code, message: failure.code, details: failure.details },
    });
  };
  parent.on("close", () => {
    providerClient?.dispose(new ProjectStoreWorkerBackendError("WORKER_CLOSED"));
  });
  parent.on("message", (value: unknown) => {
    if (accepted) {
      try {
        decodeIntegrityProviderResponseWire(value);
        if (providerClient === null) throw new ProjectStoreWorkerBackendError("WORKER_PROTOCOL_ERROR");
        providerClient.accept(value);
      } catch {
        const error = new ProjectStoreWorkerBackendError("WORKER_PROTOCOL_ERROR");
        providerClient?.dispose(error);
        postFailureOnce(activeRequestId, error);
        parent.close();
      }
      return;
    }
    accepted = true;
    let request: WorkerRequest;
    try {
      request = decodeWorkerRequest(value);
      if (request.type !== "quickIntegrity" && request.type !== "fullIntegrity") {
        throw new ProjectStoreWorkerBackendError("WORKER_PROTOCOL_ERROR");
      }
      activeRequestId = request.id;
      const binding = request.binding;
      const current = context.binding;
      if (binding.projectId !== current.projectId) {
        throw new ProjectStoreWorkerBackendError("PROJECT_ID_MISMATCH");
      }
      if (binding.vaultId !== current.vaultId) {
        throw new ProjectStoreWorkerBackendError("VAULT_ID_MISMATCH");
      }
      if (binding.storeId !== current.storeId) {
        throw new ProjectStoreWorkerBackendError("STORE_ID_MISMATCH");
      }
      if (
        binding.bindingGeneration !== current.generation
        || binding.contextFingerprint !== current.contextFingerprint
      ) {
        throw new ProjectStoreWorkerBackendError("PROJECT_BINDING_REQUIRED", {
          staleGeneration: binding.bindingGeneration,
          currentGeneration: current.generation,
        });
      }
    } catch (error) {
      const id = typeof value === "object" && value !== null && "id" in value
        && typeof value.id === "string" ? value.id : "unknown";
      postFailureOnce(id, error);
      parent.close();
      return;
    }
    providerClient = new WorkerIntegrityProviderClient(
      parent,
      request.id,
      request.type === "quickIntegrity" ? "quick" : "full",
    );
    void runIntegrityChild(context, request, providerClient).then((report) => {
      if (terminalPosted) return;
      terminalPosted = true;
      parent.postMessage({ id: request.id, ok: true, data: report });
    }).catch((error: unknown) => {
      postFailureOnce(request.id, error);
    }).finally(() => {
      providerClient?.dispose(new ProjectStoreWorkerBackendError("WORKER_CLOSED"));
      parent.close();
    });
  });
} else {
  const executorLeaseMs = role.role === "store"
    ? role.executorLeaseMs
    : DEFAULT_EXECUTOR_LEASE_MS;
  const heartbeatIntervalMs = role.role === "store"
    ? role.heartbeatIntervalMs
    : DEFAULT_HEARTBEAT_INTERVAL_MS;
  const appendRetryDeadlineMs = role.role === "store"
    ? role.appendRetryDeadlineMs
    : DEFAULT_APPEND_RETRY_DEADLINE_MS;
  const backend = new ProjectStoreWorkerBackend({
    selfUrl,
    trustedFreshStartBuildInspector: () => inspectV2Build(selfUrl.href),
    executorLeaseMs,
    appendRetryDeadlineMs,
  });
  const port: WorkerRuntimePort = {
    postMessage(value) { parent.postMessage(value); },
    close() { parent.close(); },
  };
  const scheduler: WorkerRuntimeScheduler = {
    setInterval(callback, milliseconds) { return setInterval(callback, milliseconds); },
    clearInterval(handle) { clearInterval(handle as NodeJS.Timeout); },
  };
  const runtime = new ProjectStoreWorkerRuntime({
    backend,
    port,
    scheduler,
    heartbeatIntervalMs,
  });
  parent.on("message", (value: unknown) => runtime.receive(value));
}
