import type { JsonValue } from "../contracts/event.js";
import {
  decodeWorkerRequest,
  type MaintenanceLeaseWire,
  type WorkerBindingAssertion,
  type WorkerRequest,
  type WorkerSuccessData,
} from "./worker-protocol.js";

export interface WorkerRuntimePort {
  postMessage(value: unknown): void;
  close(): void;
}

export interface WorkerRuntimeScheduler {
  setInterval(callback: () => void, milliseconds: number): object;
  clearInterval(handle: object): void;
}

export type WorkerHeartbeatObservation =
  | { mode: "idle" }
  | { mode: "quiescing"; lease: MaintenanceLeaseWire };

export interface WorkerRuntimeBackend {
  dispatch(request: WorkerRequest): Promise<WorkerSuccessData>;
  heartbeat(): Promise<WorkerHeartbeatObservation>;
  quiesceAndClose(lease: MaintenanceLeaseWire, binding: WorkerBindingAssertion): Promise<{
    executorId: string;
    epoch: string;
    fencingToken: string;
  }>;
  quiesceObservedAndClose(lease: MaintenanceLeaseWire): Promise<{
    executorId: string;
    epoch: string;
    fencingToken: string;
  }>;
  close(): Promise<void>;
}

export interface ProjectStoreWorkerRuntimeOptions {
  backend: WorkerRuntimeBackend;
  port: WorkerRuntimePort;
  scheduler: WorkerRuntimeScheduler;
  heartbeatIntervalMs: number;
}

interface SafeRuntimeError {
  code: string;
  details: Record<string, JsonValue>;
}

function safeError(error: unknown): SafeRuntimeError {
  if (typeof error !== "object" || error === null) {
    return { code: "STORE_UNAVAILABLE", details: {} };
  }
  let code = "STORE_UNAVAILABLE";
  let source: unknown;
  try {
    const observed = Reflect.get(error, "code") as unknown;
    if (typeof observed === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(observed)) code = observed;
    source = Reflect.get(error, "details") as unknown;
  } catch {
    return { code: "STORE_UNAVAILABLE", details: {} };
  }
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return { code, details: {} };
  }
  const details: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (
      value === null
      || typeof value === "string"
      || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))
    ) {
      details[key] = value;
    }
  }
  return { code, details };
}

export class ProjectStoreWorkerRuntime {
  readonly #backend: WorkerRuntimeBackend;
  readonly #port: WorkerRuntimePort;
  readonly #scheduler: WorkerRuntimeScheduler;
  readonly #heartbeatIntervalMs: number;
  #fifo: Promise<void> = Promise.resolve();
  #heartbeatHandle: object | null = null;
  #open = false;
  #closing = false;
  #quiescing = false;
  #heartbeatInFlight = false;

  constructor(options: ProjectStoreWorkerRuntimeOptions) {
    if (
      !Number.isSafeInteger(options.heartbeatIntervalMs)
      || options.heartbeatIntervalMs <= 0
    ) {
      throw new Error("WORKER_CONFIG_INVALID");
    }
    this.#backend = options.backend;
    this.#port = options.port;
    this.#scheduler = options.scheduler;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs;
  }

  receive(value: unknown): void {
    let request: WorkerRequest;
    try {
      request = decodeWorkerRequest(value);
    } catch {
      this.postFailure("unknown", { code: "WORKER_PROTOCOL_ERROR", details: {} });
      this.stop();
      return;
    }
    if (this.#closing || this.#quiescing) {
      this.postFailure(request.id, { code: "MAINTENANCE_QUIESCING", details: {} });
      return;
    }
    if (request.type === "quiesce") this.#quiescing = true;
    if (request.type === "close") this.#closing = true;
    const operation = this.#fifo.then(() => this.process(request));
    this.#fifo = operation.catch(() => undefined);
  }

  private async process(request: WorkerRequest): Promise<void> {
    if (request.type === "close") {
      this.clearHeartbeat();
      try {
        await this.#backend.close();
        this.#port.postMessage({ id: request.id, ok: true, data: { closed: true } });
      } catch (error) {
        this.postFailure(request.id, safeError(error));
      } finally {
        this.#port.close();
      }
      return;
    }
    if (request.type === "quiesce") {
      this.clearHeartbeat();
      try {
        const closed = await this.#backend.quiesceAndClose(request.lease, request.binding);
        this.#port.postMessage({
          id: request.id,
          ok: true,
          data: {
            quiesced: true,
            epoch: closed.epoch,
            connectionClosed: true,
          },
        });
        this.#port.postMessage({
          type: "quiesced",
          executorId: closed.executorId,
          epoch: closed.epoch,
          fencingToken: closed.fencingToken,
          ownerId: request.lease.ownerId,
          leaseExpiresAt: request.lease.leaseExpiresAt,
          connectionClosed: true,
        });
      } catch (error) {
        this.postFailure(request.id, safeError(error));
      } finally {
        this.#closing = true;
        this.#port.close();
      }
      return;
    }
    try {
      const data = await this.#backend.dispatch(request);
      this.#port.postMessage({ id: request.id, ok: true, data });
      if (request.type === "open") {
        this.#open = true;
        this.startHeartbeat();
      }
      if (request.type === "verifyIdentity" || request.type === "inspectExisting") {
        this.#closing = true;
        this.#port.close();
      }
    } catch (error) {
      this.postFailure(request.id, safeError(error));
      if (request.type === "open" || request.type === "verifyIdentity" || request.type === "inspectExisting") {
        this.#closing = true;
        this.#port.close();
      }
    }
  }

  private startHeartbeat(): void {
    if (this.#heartbeatHandle !== null) return;
    this.#heartbeatHandle = this.#scheduler.setInterval(() => {
      void this.heartbeat();
    }, this.#heartbeatIntervalMs);
  }

  private async heartbeat(): Promise<void> {
    if (!this.#open || this.#closing || this.#quiescing || this.#heartbeatInFlight) return;
    this.#heartbeatInFlight = true;
    try {
      const observation = await this.#backend.heartbeat();
      if (observation.mode === "quiescing") this.beginObservedQuiesce(observation.lease);
    } catch {
      this.stop();
    } finally {
      this.#heartbeatInFlight = false;
    }
  }

  private beginObservedQuiesce(lease: MaintenanceLeaseWire): void {
    if (this.#quiescing || this.#closing) return;
    this.#quiescing = true;
    this.clearHeartbeat();
    const accepted = this.#fifo;
    void accepted.then(async () => {
      try {
        const closed = await this.#backend.quiesceObservedAndClose(lease);
        this.#port.postMessage({
          type: "quiesced",
          executorId: closed.executorId,
          epoch: closed.epoch,
          fencingToken: closed.fencingToken,
          ownerId: lease.ownerId,
          leaseExpiresAt: lease.leaseExpiresAt,
          connectionClosed: true,
        });
      } finally {
        this.#closing = true;
        this.#port.close();
      }
    }).catch(() => this.stop());
  }

  private postFailure(id: string, error: SafeRuntimeError): void {
    try {
      this.#port.postMessage({
        id,
        ok: false,
        error: { code: error.code, message: error.code, details: error.details },
      });
    } catch {
      this.stop();
    }
  }

  private clearHeartbeat(): void {
    if (this.#heartbeatHandle === null) return;
    this.#scheduler.clearInterval(this.#heartbeatHandle);
    this.#heartbeatHandle = null;
  }

  private stop(): void {
    if (this.#closing) return;
    this.#closing = true;
    this.clearHeartbeat();
    void this.#backend.close().catch(() => undefined).finally(() => this.#port.close());
  }
}
