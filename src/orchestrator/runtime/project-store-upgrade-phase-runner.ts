import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { ProjectContext } from "../identity/contracts.js";
import {
  parsePreparedStoreIntegrityManifest,
  StoreManifestRepository,
  type PreparedStoreIntegrityManifest,
} from "../identity/store-manifest.repository.js";
import type { IntegrityReport } from "../integrity/integrity.types.js";
import {
  decodeIntegrityReport,
  encodeWorkerBinding,
} from "./worker-protocol.js";

export interface UpgradePhaseWorkerLike {
  terminate(): Promise<number>;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "messageerror", listener: (error: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (exitCode: number) => void): this;
  off(event: "message", listener: (value: unknown) => void): this;
  off(event: "messageerror", listener: (error: unknown) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  off(event: "exit", listener: (exitCode: number) => void): this;
}

export interface ProjectStoreUpgradePhaseRunnerDependencies {
  workerUrl: URL;
  workerFactory(
    workerUrl: URL,
    options: { workerData: Record<string, unknown> },
  ): UpgradePhaseWorkerLike;
}

export class ProjectStoreUpgradePhaseRunnerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProjectStoreUpgradePhaseRunnerError";
  }
}

function defaultWorkerFactory(
  workerUrl: URL,
  options: { workerData: Record<string, unknown> },
): UpgradePhaseWorkerLike {
  return new Worker(workerUrl, { workerData: options.workerData });
}

function failureCode(value: unknown): string {
  try {
    if (typeof value !== "object" || value === null) return "STORE_UNAVAILABLE";
    const error = Reflect.get(value, "error");
    if (typeof error !== "object" || error === null) return "STORE_UNAVAILABLE";
    const code = Reflect.get(error, "code");
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
      ? code
      : "STORE_UNAVAILABLE";
  } catch {
    return "STORE_UNAVAILABLE";
  }
}

export class ProjectStoreUpgradePhaseRunner {
  readonly #dependencies: ProjectStoreUpgradePhaseRunnerDependencies;

  constructor(
    dependencies: Partial<ProjectStoreUpgradePhaseRunnerDependencies> = {},
  ) {
    this.#dependencies = {
      workerUrl: dependencies.workerUrl
        ?? new URL("../../workers/project-store-upgrade-phase.worker.js", import.meta.url),
      workerFactory: dependencies.workerFactory ?? defaultWorkerFactory,
    };
    if (
      !(this.#dependencies.workerUrl instanceof URL)
      || this.#dependencies.workerUrl.protocol !== "file:"
    ) {
      throw new ProjectStoreUpgradePhaseRunnerError("WORKER_CONFIG_INVALID");
    }
  }

  fullIntegrity(
    context: ProjectContext,
    signal: AbortSignal,
  ): Promise<IntegrityReport> {
    return this.run(
      {
        phase: "full-integrity",
        binding: encodeWorkerBinding(context),
      },
      (value) => decodeIntegrityReport(value),
      signal,
    );
  }

  prepareManifest(
    context: ProjectContext,
    report: IntegrityReport,
    signal: AbortSignal,
  ): Promise<PreparedStoreIntegrityManifest> {
    const preparationId = randomUUID();
    return this.run(
      {
        phase: "manifest-prepare",
        binding: encodeWorkerBinding(context),
        report,
        preparationId,
      },
      (value) => {
        const prepared = parsePreparedStoreIntegrityManifest(value);
        if (prepared.preparationId !== preparationId) {
          throw new ProjectStoreUpgradePhaseRunnerError("WORKER_PROTOCOL_ERROR");
        }
        return prepared;
      },
      signal,
    ).catch((error: unknown) => {
      try {
        new StoreManifestRepository().discardIntegrityPreparation(
          context.binding.storeRoute,
          preparationId,
        );
      } catch {
        // The phase failure remains authoritative; crash residue is never publishable by path.
      }
      throw error;
    });
  }

  private run<T>(
    workerData: Record<string, unknown>,
    decode: (value: unknown) => T,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(new ProjectStoreUpgradePhaseRunnerError("WORKER_CLOSED"));
    }
    let worker: UpgradePhaseWorkerLike;
    try {
      worker = this.#dependencies.workerFactory(this.#dependencies.workerUrl, { workerData });
    } catch {
      return Promise.reject(new ProjectStoreUpgradePhaseRunnerError("WORKER_UNAVAILABLE"));
    }
    return new Promise<T>((resolvePhase, rejectPhase) => {
      let decoded: T | undefined;
      let received = false;
      let settled = false;
      let terminating = false;
      let terminalError: ProjectStoreUpgradePhaseRunnerError | undefined;

      const onMessage = (value: unknown): void => {
        if (settled || terminating || received) {
          terminateWith(new ProjectStoreUpgradePhaseRunnerError("WORKER_PROTOCOL_ERROR"));
          return;
        }
        try {
          if (
            typeof value !== "object"
            || value === null
            || typeof Reflect.get(value, "ok") !== "boolean"
          ) {
            throw new ProjectStoreUpgradePhaseRunnerError("WORKER_PROTOCOL_ERROR");
          }
          if (Reflect.get(value, "ok") === false) {
            terminateWith(new ProjectStoreUpgradePhaseRunnerError(failureCode(value)));
            return;
          }
          if (Reflect.ownKeys(value).length !== 2 || !("data" in value)) {
            throw new ProjectStoreUpgradePhaseRunnerError("WORKER_PROTOCOL_ERROR");
          }
          decoded = decode(Reflect.get(value, "data"));
          received = true;
        } catch (error) {
          terminateWith(error instanceof ProjectStoreUpgradePhaseRunnerError
            ? error
            : new ProjectStoreUpgradePhaseRunnerError("WORKER_PROTOCOL_ERROR"));
        }
      };
      const onMessageError = (): void => {
        terminateWith(new ProjectStoreUpgradePhaseRunnerError("WORKER_PROTOCOL_ERROR"));
      };
      const onError = (): void => {
        terminateWith(new ProjectStoreUpgradePhaseRunnerError("WORKER_UNAVAILABLE"));
      };
      const onExit = (exitCode: number): void => {
        if (settled) return;
        if (terminating) {
          finishReject(terminalError ?? new ProjectStoreUpgradePhaseRunnerError("WORKER_UNAVAILABLE"));
          return;
        }
        if (exitCode !== 0 || !received) {
          finishReject(new ProjectStoreUpgradePhaseRunnerError("WORKER_UNAVAILABLE"));
          return;
        }
        finishResolve(decoded as T);
      };
      const onAbort = (): void => {
        terminateWith(new ProjectStoreUpgradePhaseRunnerError("WORKER_CLOSED"));
      };
      const removeListeners = (): void => {
        signal.removeEventListener("abort", onAbort);
        worker.off("message", onMessage);
        worker.off("messageerror", onMessageError);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };
      const finishReject = (error: ProjectStoreUpgradePhaseRunnerError): void => {
        if (settled) return;
        settled = true;
        removeListeners();
        rejectPhase(error);
      };
      const finishResolve = (value: T): void => {
        if (settled) return;
        settled = true;
        removeListeners();
        resolvePhase(value);
      };
      const terminateWith = (error: ProjectStoreUpgradePhaseRunnerError): void => {
        if (settled || terminating) return;
        terminating = true;
        terminalError = error;
        let termination: Promise<number>;
        try {
          termination = worker.terminate();
        } catch {
          finishReject(error);
          return;
        }
        void termination.then(
          () => finishReject(error),
          () => finishReject(error),
        );
      };

      signal.addEventListener("abort", onAbort, { once: true });
      worker.on("message", onMessage);
      worker.on("messageerror", onMessageError);
      worker.on("error", onError);
      worker.on("exit", onExit);
      if (signal.aborted) onAbort();
    });
  }
}
