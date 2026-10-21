import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { ProjectContext } from "../identity/contracts.js";
import type { MaintenanceLease } from "../storage/maintenance-fence.js";
import type {
  ProjectStoreUpgradePlan,
  ProjectStoreUpgradeResult,
  UpgradeExecutorRegistry,
} from "../storage/project-store-upgrade.service.js";
import type { MaintenanceClosureConfirmation, WorkerLike } from "./project-store-executor.js";
import {
  decodeMaintenanceLeaseWire,
  decodeProjectStoreUpgradePlan,
  decodeProjectStoreUpgradeResult,
  decodeUpgradeQuiesceRequiredNotification,
  encodeMaintenanceLeaseWire,
  encodeWorkerBinding,
} from "./worker-protocol.js";

export interface ProjectStoreUpgradeExecutorOptions {
  workerUrl: URL;
  context: ProjectContext;
  requestTimeoutMs: number;
  trustedTtlMs?: number;
}

export interface ProjectStoreUpgradeExecutorDependencies {
  workerFactory(
    workerUrl: URL,
    options: { workerData: Record<string, unknown> },
  ): WorkerLike;
  executorRegistry: UpgradeExecutorRegistry;
  randomId: () => string;
  setTimeout(callback: () => void, milliseconds: number): object;
  clearTimeout(handle: object): void;
}

interface Pending {
  kind: "inspect" | "apply" | "confirmation";
  timer: object;
  resolve(value: unknown): void;
  reject(error: ProjectStoreUpgradeExecutorError): void;
}

const NO_EXECUTORS: UpgradeExecutorRegistry = {
  async quiesceStore() { /* no process-local executor registry */ },
};

function defaultWorkerFactory(
  workerUrl: URL,
  options: { workerData: Record<string, unknown> },
): WorkerLike {
  return new Worker(workerUrl, { workerData: options.workerData });
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ProjectStoreUpgradeExecutorError("WORKER_CONFIG_INVALID");
  }
  return Number(value);
}

function safeError(value: unknown): ProjectStoreUpgradeExecutorError {
  try {
    if (typeof value !== "object" || value === null) {
      return new ProjectStoreUpgradeExecutorError("STORE_UNAVAILABLE");
    }
    const error = Reflect.get(value, "error");
    if (typeof error !== "object" || error === null) {
      return new ProjectStoreUpgradeExecutorError("STORE_UNAVAILABLE");
    }
    const code = Reflect.get(error, "code");
    return new ProjectStoreUpgradeExecutorError(
      typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
        ? code
        : "STORE_UNAVAILABLE",
    );
  } catch {
    return new ProjectStoreUpgradeExecutorError("STORE_UNAVAILABLE");
  }
}

export class ProjectStoreUpgradeExecutorError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProjectStoreUpgradeExecutorError";
  }
}

export class ProjectStoreUpgradeExecutor {
  readonly #options: ProjectStoreUpgradeExecutorOptions;
  readonly #dependencies: ProjectStoreUpgradeExecutorDependencies;
  readonly #worker: WorkerLike;
  readonly #pending = new Map<string, Pending>();
  #activeApplyId: string | null = null;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(
    options: ProjectStoreUpgradeExecutorOptions,
    dependencies: Partial<ProjectStoreUpgradeExecutorDependencies> = {},
  ) {
    if (!(options.workerUrl instanceof URL) || options.workerUrl.protocol !== "file:") {
      throw new ProjectStoreUpgradeExecutorError("WORKER_CONFIG_INVALID");
    }
    this.#options = {
      ...options,
      requestTimeoutMs: positive(options.requestTimeoutMs),
      ...(options.trustedTtlMs === undefined
        ? {}
        : { trustedTtlMs: positive(options.trustedTtlMs) }),
    };
    this.#dependencies = {
      workerFactory: dependencies.workerFactory ?? defaultWorkerFactory,
      executorRegistry: dependencies.executorRegistry ?? NO_EXECUTORS,
      randomId: dependencies.randomId ?? randomUUID,
      setTimeout: dependencies.setTimeout ?? ((callback, milliseconds) => (
        setTimeout(callback, milliseconds)
      )),
      clearTimeout: dependencies.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)),
    };
    this.#worker = this.#dependencies.workerFactory(options.workerUrl, {
      workerData: {
        role: "upgrade",
        binding: encodeWorkerBinding(options.context),
        ...(options.trustedTtlMs === undefined ? {} : { trustedTtlMs: options.trustedTtlMs }),
      },
    });
    this.#worker.on("message", (value) => this.onMessage(value));
    this.#worker.on("messageerror", () => this.fail(new ProjectStoreUpgradeExecutorError("WORKER_PROTOCOL_ERROR")));
    this.#worker.on("error", () => this.fail(new ProjectStoreUpgradeExecutorError("WORKER_UNAVAILABLE")));
    this.#worker.on("exit", (exitCode) => {
      if (!this.#closed && exitCode !== 0) this.fail(new ProjectStoreUpgradeExecutorError("WORKER_UNAVAILABLE"));
      else if (!this.#closed && this.#pending.size !== 0) {
        this.fail(new ProjectStoreUpgradeExecutorError("WORKER_UNAVAILABLE"));
      }
    });
  }

  inspect(): Promise<ProjectStoreUpgradePlan> {
    return this.request("inspect", "upgrade-inspect")
      .then((value) => decodeProjectStoreUpgradePlan(value));
  }

  apply(): Promise<ProjectStoreUpgradeResult> {
    if (this.#activeApplyId !== null) {
      return Promise.reject(new ProjectStoreUpgradeExecutorError("MAINTENANCE_ALREADY_ACTIVE"));
    }
    const id = this.nextId();
    this.#activeApplyId = id;
    return this.requestWithId("apply", id, { id, type: "upgrade-apply" })
      .then((value) => decodeProjectStoreUpgradeResult(value))
      .finally(() => {
        if (this.#activeApplyId === id) this.#activeApplyId = null;
      });
  }

  confirmMaintenanceClosure(
    confirmation: MaintenanceClosureConfirmation,
  ): Promise<void> {
    const operationId = this.#activeApplyId;
    if (operationId === null) {
      return Promise.reject(new ProjectStoreUpgradeExecutorError("MAINTENANCE_CONFIRMATION_FAILED"));
    }
    const id = this.nextId();
    return this.requestWithId("confirmation", id, {
      id,
      type: "upgrade-confirm-closure",
      operationId,
      confirmation: {
        projectId: confirmation.projectId,
        executorId: confirmation.executorId,
        lease: encodeMaintenanceLeaseWire(confirmation.lease),
        connectionClosed: true,
      },
    }).then((value) => {
      if (
        typeof value !== "object"
        || value === null
        || Reflect.get(value, "confirmed") !== true
        || Reflect.ownKeys(value).length !== 1
      ) {
        throw new ProjectStoreUpgradeExecutorError("WORKER_PROTOCOL_ERROR");
      }
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    const failure = new ProjectStoreUpgradeExecutorError("WORKER_CLOSED");
    for (const [id, pending] of this.#pending) {
      this.#dependencies.clearTimeout(pending.timer);
      pending.reject(failure);
      this.#pending.delete(id);
    }
    this.#closePromise = this.#worker.terminate().then(() => undefined, () => {
      throw new ProjectStoreUpgradeExecutorError("WORKER_UNAVAILABLE");
    });
    return this.#closePromise;
  }

  private request(kind: "inspect", type: "upgrade-inspect"): Promise<unknown> {
    const id = this.nextId();
    return this.requestWithId(kind, id, { id, type });
  }

  private requestWithId(kind: Pending["kind"], id: string, value: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new ProjectStoreUpgradeExecutorError("WORKER_CLOSED"));
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = this.#dependencies.setTimeout(() => {
        this.fail(new ProjectStoreUpgradeExecutorError("WORKER_TIMEOUT"));
      }, this.#options.requestTimeoutMs);
      this.#pending.set(id, {
        kind,
        timer,
        resolve: resolveRequest,
        reject: rejectRequest,
      });
      try {
        this.#worker.postMessage(value);
      } catch {
        this.#pending.delete(id);
        this.#dependencies.clearTimeout(timer);
        rejectRequest(new ProjectStoreUpgradeExecutorError("WORKER_UNAVAILABLE"));
      }
    });
  }

  private nextId(): string {
    const id = this.#dependencies.randomId();
    if (typeof id !== "string" || id.length === 0 || this.#pending.has(id)) {
      throw new ProjectStoreUpgradeExecutorError("WORKER_CONFIG_INVALID");
    }
    return id;
  }

  private onMessage(value: unknown): void {
    try {
      if (
        typeof value === "object"
        && value !== null
        && Reflect.get(value, "type") === "upgrade-quiesce-required"
      ) {
        const notification = decodeUpgradeQuiesceRequiredNotification(value);
        if (
          this.#activeApplyId === null
          || notification.operationId !== this.#activeApplyId
        ) {
          throw new ProjectStoreUpgradeExecutorError("WORKER_PROTOCOL_ERROR");
        }
        const lease: MaintenanceLease = decodeMaintenanceLeaseWire(notification.lease);
        void this.#dependencies.executorRegistry.quiesceStore(this.#options.context, lease)
          .then(() => {
            if (this.#closed) return;
            this.#worker.postMessage({
              type: "upgrade-quiesce-complete",
              operationId: notification.operationId,
            });
          })
          .catch(() => this.fail(new ProjectStoreUpgradeExecutorError("MAINTENANCE_CONFIRMATION_FAILED")));
        return;
      }
      if (typeof value !== "object" || value === null) {
        throw new ProjectStoreUpgradeExecutorError("WORKER_PROTOCOL_ERROR");
      }
      const id = Reflect.get(value, "id");
      const ok = Reflect.get(value, "ok");
      if (typeof id !== "string" || typeof ok !== "boolean") {
        throw new ProjectStoreUpgradeExecutorError("WORKER_PROTOCOL_ERROR");
      }
      const pending = this.#pending.get(id);
      if (pending === undefined) throw new ProjectStoreUpgradeExecutorError("WORKER_PROTOCOL_ERROR");
      this.#pending.delete(id);
      this.#dependencies.clearTimeout(pending.timer);
      if (!ok) pending.reject(safeError(value));
      else if (Reflect.ownKeys(value).length !== 3 || !("data" in value)) {
        pending.reject(new ProjectStoreUpgradeExecutorError("WORKER_PROTOCOL_ERROR"));
      } else {
        pending.resolve(Reflect.get(value, "data"));
      }
    } catch (error) {
      this.fail(error instanceof ProjectStoreUpgradeExecutorError
        ? error
        : new ProjectStoreUpgradeExecutorError("WORKER_PROTOCOL_ERROR"));
    }
  }

  private fail(error: ProjectStoreUpgradeExecutorError): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      this.#dependencies.clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
    void this.#worker.terminate().catch(() => undefined);
  }
}
