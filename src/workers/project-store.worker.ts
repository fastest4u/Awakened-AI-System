import { parentPort, workerData } from "node:worker_threads";
import {
  ProjectStoreWorkerBackend,
  ProjectStoreWorkerBackendError,
  runIntegrityChild,
} from "../orchestrator/runtime/project-store-worker-backend.js";
import {
  ProjectStoreWorkerRuntime,
  type WorkerRuntimePort,
  type WorkerRuntimeScheduler,
} from "../orchestrator/runtime/project-store-worker-runtime.js";
import {
  decodeWorkerBinding,
  decodeWorkerRequest,
  type WorkerRequest,
} from "../orchestrator/runtime/worker-protocol.js";

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
  | { role: "integrity"; binding: unknown };

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

if (role.role === "integrity") {
  const context = decodeWorkerBinding(role.binding);
  let accepted = false;
  parent.on("message", (value: unknown) => {
    if (accepted) {
      parent.postMessage({
        id: "unknown",
        ok: false,
        error: { code: "WORKER_PROTOCOL_ERROR", message: "WORKER_PROTOCOL_ERROR", details: {} },
      });
      parent.close();
      return;
    }
    accepted = true;
    let request: WorkerRequest;
    try {
      request = decodeWorkerRequest(value);
      if (request.type !== "quickIntegrity" && request.type !== "fullIntegrity") {
        throw new ProjectStoreWorkerBackendError("WORKER_PROTOCOL_ERROR");
      }
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
      const failure = safeFailure(error);
      const id = typeof value === "object" && value !== null && "id" in value
        && typeof value.id === "string" ? value.id : "unknown";
      parent.postMessage({
        id,
        ok: false,
        error: { code: failure.code, message: failure.code, details: failure.details },
      });
      parent.close();
      return;
    }
    void runIntegrityChild(context, request).then((report) => {
      parent.postMessage({ id: request.id, ok: true, data: report });
    }).catch((error: unknown) => {
      const failure = safeFailure(error);
      parent.postMessage({
        id: request.id,
        ok: false,
        error: { code: failure.code, message: failure.code, details: failure.details },
      });
    }).finally(() => parent.close());
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
