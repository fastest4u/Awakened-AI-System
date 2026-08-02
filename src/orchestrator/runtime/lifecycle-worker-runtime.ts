import type { ProjectContext } from "../identity/contracts.js";
import type { WorkerLifecycleResult } from "../lifecycle/authority/authority-material-adapter.js";
import type {
  LifecycleSemanticCommandDraft,
  PreparedLifecycleWorkerCommand,
} from "../lifecycle/contracts/commands.js";
import type {
  CheckpointRecordedResult,
} from "../lifecycle/checkpoint.service.js";
import type { ChildWorkflowService } from "../lifecycle/child-workflow.service.js";
import type { EvidenceCoverageRecordedResultV2 } from "../lifecycle/evidence-coverage.service.js";
import type { LifecycleCommandProcessor } from "../lifecycle/lifecycle-command.processor.js";
import type { LifecycleCommandStore } from "../lifecycle/lifecycle-command.store.js";
import type { LifecycleOperationalStore } from "../lifecycle/lifecycle-operational.store.js";
import type { LifecycleQueryService } from "../lifecycle/lifecycle-query.service.js";
import type {
  LifecycleWorkerOperationWire,
  LifecycleWorkerSuccessWire,
} from "./lifecycle-worker-protocol.js";
import {
  lifecycleNestedContractVersion,
  materializeLifecycleWorkerOperation,
} from "./lifecycle-worker-protocol.js";
import { LifecycleError } from "../lifecycle/errors.js";
import type { JsonValue } from "../contracts/event.js";

export interface LifecycleWorkerRuntime {
  execute(
    operation: LifecycleWorkerOperationWire,
    context: ProjectContext,
  ): Promise<LifecycleWorkerSuccessWire>;
  dispose(): void;
}

export interface PreparedCheckpointLifecycleHandler {
  execute(
    context: ProjectContext,
    prepared: PreparedLifecycleWorkerCommand<Extract<
      LifecycleSemanticCommandDraft,
      { readonly commandType: "record-checkpoint" }
    >>,
  ): WorkerLifecycleResult<CheckpointRecordedResult>;
}

export interface PreparedEvidenceLifecycleHandler {
  execute(
    context: ProjectContext,
    prepared: PreparedLifecycleWorkerCommand<Extract<
      LifecycleSemanticCommandDraft,
      { readonly commandType: "record-evidence-batch" }
    >>,
  ): WorkerLifecycleResult<EvidenceCoverageRecordedResultV2>;
}

export interface ConnectionBoundLifecycleWorkerRuntimeOptions {
  readonly rootProcessor: LifecycleCommandProcessor;
  readonly childService: ChildWorkflowService;
  readonly checkpointHandler: PreparedCheckpointLifecycleHandler;
  readonly evidenceHandler: PreparedEvidenceLifecycleHandler;
  readonly queryService: LifecycleQueryService;
  readonly semanticStore: LifecycleCommandStore;
  readonly operationalStore: LifecycleOperationalStore;
}

export class ConnectionBoundLifecycleWorkerRuntime
implements LifecycleWorkerRuntime {
  #options: ConnectionBoundLifecycleWorkerRuntimeOptions | null;

  constructor(options: ConnectionBoundLifecycleWorkerRuntimeOptions) {
    const required = [
      "rootProcessor",
      "childService",
      "checkpointHandler",
      "evidenceHandler",
      "queryService",
      "semanticStore",
      "operationalStore",
    ] as const;
    if (options === null || typeof options !== "object") {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    for (const key of required) {
      const descriptor = Reflect.getOwnPropertyDescriptor(options, key);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.value === null
        || typeof descriptor.value !== "object") {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
    }
    this.#options = Object.freeze({ ...options });
  }

  async execute(
    operation: LifecycleWorkerOperationWire,
    context: ProjectContext,
  ): Promise<LifecycleWorkerSuccessWire> {
    const options = this.#options;
    if (options === null) throw new LifecycleError("LIFECYCLE_V2_DISABLED");

    if (operation.kind === "semantic") {
      switch (operation.operation) {
        case "create-child-transfer":
        case "request-session-end":
        case "amend-session-end":
        case "cancel-session-end":
        case "abandon-session":
          return Object.freeze({
            operation: operation.operation,
            nestedContractVersion: lifecycleNestedContractVersion(operation),
            result: Object.freeze({
              kind: "rejected",
              errorCode: "LIFECYCLE_OPERATION_UNAVAILABLE",
            }),
          });
      }
    } else if (operation.kind === "internal-semantic" || operation.kind === "fenced") {
      throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
    }

    const nestedContractVersion = lifecycleNestedContractVersion(operation);
    const success = (result: JsonValue): LifecycleWorkerSuccessWire => Object.freeze({
      operation: operation.operation,
      nestedContractVersion,
      result,
    });

    const materialized = materializeLifecycleWorkerOperation(operation, context);
    if (operation.kind === "bounded") {
      return success(options.rootProcessor.renewRootLease(context, materialized as never) as unknown as JsonValue);
    }
    if (operation.kind === "query") {
      return success(options.queryService.read(context, materialized as never) as unknown as JsonValue);
    }
    if (operation.kind !== "semantic") {
      throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
    }

    switch (operation.operation) {
      case "root-start":
        return success(options.rootProcessor.startRoot(context, materialized as never) as JsonValue);
      case "root-resume":
        return success(options.rootProcessor.resumeRoot(context, materialized as never) as JsonValue);
      case "root-recovery":
        return success(options.rootProcessor.recoverRoot(context, materialized as never) as JsonValue);
      case "root-suspend":
        return success(options.rootProcessor.suspendRoot(context, materialized as never) as JsonValue);
      case "fork-child":
      case "amend-child-assignment":
      case "record-child-report":
      case "disposition-child-report":
      case "propose-child-completion":
      case "complete-child-session":
      case "suspend-child-session":
      case "claim-child-transfer":
        return success(options.childService.execute(context, materialized as never) as JsonValue);
      case "record-checkpoint":
        return success(options.checkpointHandler.execute(context, materialized as never) as JsonValue);
      case "record-evidence-batch":
        return success(options.evidenceHandler.execute(context, materialized as never) as JsonValue);
      default:
        throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
    }
  }

  dispose(): void {
    this.#options = null;
  }
}
