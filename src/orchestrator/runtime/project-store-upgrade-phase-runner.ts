import { Worker } from "node:worker_threads";
import type { ProjectContext } from "../identity/contracts.js";
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

  recordManifest(
    context: ProjectContext,
    report: IntegrityReport,
    signal: AbortSignal,
  ): Promise<void> {
    return this.run(
      {
        phase: "manifest-record",
        binding: encodeWorkerBinding(context),
        report,
      },
      (value) => {
        if (
          typeof value !== "object"
          || value === null
          || Reflect.ownKeys(value).length !== 1
          || Reflect.get(value, "recorded") !== true
        ) {
          throw new ProjectStoreUpgradePhaseRunnerError("WORKER_PROTOCOL_ERROR");
        }
      },
      signal,
    );
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
      let phaseError: ProjectStoreUpgradePhaseRunnerError | undefined;
      let settled = false;
      let terminating = false;
      const finishReject = (error: ProjectStoreUpgradePhaseRunnerError): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        rejectPhase(error);
      };
      const terminateWith = (error: ProjectStoreUpgradePhaseRunnerError): void => {
        if (settled || terminating) return;
        terminating = true;
        phaseError = error;
        void worker.terminate().catch(() => undefined);
      };
      const onAbort = (): void => {
        terminateWith(new ProjectStoreUpgradePhaseRunnerError("WORKER_CLOSED"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      worker.on("message", (value) => {
        if (settled || terminating || received || phaseError !== undefined) {
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
            phaseError = new ProjectStoreUpgradePhaseRunnerError(failureCode(value));
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
      });
      worker.on("messageerror", () => {
        terminateWith(new ProjectStoreUpgradePhaseRunnerError("WORKER_PROTOCOL_ERROR"));
      });
      worker.on("error", () => {
        terminateWith(new ProjectStoreUpgradePhaseRunnerError("WORKER_UNAVAILABLE"));
      });
      worker.on("exit", (exitCode) => {
        if (settled) return;
        if (terminating || phaseError !== undefined) {
          finishReject(phaseError ?? new ProjectStoreUpgradePhaseRunnerError("WORKER_UNAVAILABLE"));
          return;
        }
        if (exitCode !== 0 || !received) {
          finishReject(new ProjectStoreUpgradePhaseRunnerError("WORKER_UNAVAILABLE"));
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolvePhase(decoded as T);
      });
    });
  }
}
