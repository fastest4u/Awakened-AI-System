import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type {
  ProjectId,
  ProjectStoreRoute,
  StoreId,
  VaultId,
} from "../identity/contracts.js";
import {
  ProjectBindingError,
  type ProjectStoreIdentity,
  type ProjectStoreIdentityProbe,
} from "../identity/project-binding.service.js";
import {
  decodeWorkerMessage,
  decodeWorkerResponseForRequest,
  type StoreIdentityWire,
  type WorkerRequest,
  type WorkerResponse,
} from "./worker-protocol.js";
import type { ExecutorScheduler, WorkerFactory, WorkerLike } from "./project-store-executor.js";

const DEFAULT_IDENTITY_TIMEOUT_MS = 10_000;
const IDENTITY_CODES = new Set([
  "PROJECT_ID_MISMATCH",
  "VAULT_ID_MISMATCH",
  "STORE_ID_MISMATCH",
]);

const scheduler: ExecutorScheduler = {
  setTimeout(callback, milliseconds) {
    return setTimeout(callback, milliseconds);
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

const workerFactory: WorkerFactory = (workerUrl, options) => new Worker(workerUrl, {
  workerData: options.workerData,
});

export interface WorkerProjectStoreIdentityProbeOptions {
  workerUrl: URL;
  requestTimeoutMs?: number;
}

export interface WorkerProjectStoreIdentityProbeDependencies {
  workerFactory: WorkerFactory;
  scheduler: ExecutorScheduler;
  randomId: () => string;
}

function probeFailure(code: string): ProjectBindingError {
  return new ProjectBindingError(
    IDENTITY_CODES.has(code)
      ? code as "PROJECT_ID_MISMATCH" | "VAULT_ID_MISMATCH" | "STORE_ID_MISMATCH"
      : "STORE_UNAVAILABLE",
  );
}

function routeWire(route: ProjectStoreRoute): ProjectStoreRoute {
  return {
    kind: route.kind,
    storeRoot: route.storeRoot,
    eventsPath: route.eventsPath,
    storeManifestPath: route.storeManifestPath,
    projectionManifestPath: route.projectionManifestPath,
  };
}

export class WorkerProjectStoreIdentityProbe implements ProjectStoreIdentityProbe {
  readonly #options: Required<WorkerProjectStoreIdentityProbeOptions>;
  readonly #dependencies: WorkerProjectStoreIdentityProbeDependencies;

  constructor(
    options: WorkerProjectStoreIdentityProbeOptions,
    dependencies: Partial<WorkerProjectStoreIdentityProbeDependencies> = {},
  ) {
    if (
      !(options.workerUrl instanceof URL)
      || options.workerUrl.protocol !== "file:"
      || !Number.isSafeInteger(options.requestTimeoutMs ?? DEFAULT_IDENTITY_TIMEOUT_MS)
      || (options.requestTimeoutMs ?? DEFAULT_IDENTITY_TIMEOUT_MS) <= 0
    ) {
      throw new ProjectBindingError("STORE_UNAVAILABLE");
    }
    this.#options = {
      workerUrl: options.workerUrl,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_IDENTITY_TIMEOUT_MS,
    };
    this.#dependencies = {
      workerFactory: dependencies.workerFactory ?? workerFactory,
      scheduler: dependencies.scheduler ?? scheduler,
      randomId: dependencies.randomId ?? randomUUID,
    };
  }

  async verify(
    route: ProjectStoreRoute,
    expected: { projectId: ProjectId; vaultId: VaultId; storeId: StoreId },
  ): Promise<void> {
    const response = await this.oneShot({
      id: this.#dependencies.randomId(),
      type: "verifyIdentity",
      route: routeWire(route),
      expected: { ...expected },
    });
    if (!response.ok || !("verified" in response.data) || response.data.verified !== true) {
      throw !response.ok ? probeFailure(response.error.code) : probeFailure("STORE_UNAVAILABLE");
    }
  }

  async inspectExisting(
    route: ProjectStoreRoute,
    expected: { projectId: ProjectId; vaultId: VaultId },
  ): Promise<ProjectStoreIdentity> {
    const response = await this.oneShot({
      id: this.#dependencies.randomId(),
      type: "inspectExisting",
      route: routeWire(route),
      expected: { ...expected },
    });
    if (!response.ok) throw probeFailure(response.error.code);
    const data = response.data as StoreIdentityWire;
    if (
      data.projectId !== expected.projectId
      || data.vaultId !== expected.vaultId
      || typeof data.storeId !== "string"
    ) {
      throw probeFailure(
        data.projectId !== expected.projectId
          ? "PROJECT_ID_MISMATCH"
          : data.vaultId !== expected.vaultId
            ? "VAULT_ID_MISMATCH"
            : "STORE_UNAVAILABLE",
      );
    }
    return {
      projectId: data.projectId as ProjectId,
      vaultId: data.vaultId as VaultId,
      storeId: data.storeId as StoreId,
    };
  }

  private oneShot(request: WorkerRequest): Promise<WorkerResponse> {
    const worker = this.#dependencies.workerFactory(this.#options.workerUrl, {
      workerData: { role: "identity" },
    });
    return new Promise<WorkerResponse>((resolveResponse, rejectResponse) => {
      let response: WorkerResponse | undefined;
      let settled = false;
      const timer = this.#dependencies.scheduler.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#dependencies.scheduler.clearTimeout(timer);
        void worker.terminate().catch(() => undefined).then(() => {
          rejectResponse(probeFailure("WORKER_TIMEOUT"));
        });
      }, this.#options.requestTimeoutMs);
      const fail = (code: string): void => {
        if (settled) return;
        settled = true;
        this.#dependencies.scheduler.clearTimeout(timer);
        void worker.terminate().catch(() => undefined).then(() => {
          rejectResponse(probeFailure(code));
        });
      };
      worker.on("message", (value) => {
        if (settled) return;
        try {
          if (response !== undefined) {
            fail("WORKER_PROTOCOL_ERROR");
            return;
          }
          const decoded = decodeWorkerMessage(value);
          if (!("id" in decoded) || decoded.id !== request.id) {
            fail("WORKER_PROTOCOL_ERROR");
            return;
          }
          response = decodeWorkerResponseForRequest(decoded, request);
        } catch {
          fail("WORKER_PROTOCOL_ERROR");
        }
      });
      worker.on("messageerror", () => fail("WORKER_PROTOCOL_ERROR"));
      worker.on("error", () => fail("WORKER_UNAVAILABLE"));
      worker.on("exit", (exitCode) => {
        if (settled) return;
        if (exitCode !== 0 || response === undefined) {
          fail("WORKER_UNAVAILABLE");
          return;
        }
        settled = true;
        this.#dependencies.scheduler.clearTimeout(timer);
        resolveResponse(response);
      });
      try {
        worker.postMessage(request);
      } catch {
        fail("WORKER_UNAVAILABLE");
      }
    });
  }
}
