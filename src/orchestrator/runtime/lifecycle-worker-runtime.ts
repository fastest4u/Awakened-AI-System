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
import type { SessionEndChildService } from "../lifecycle/session-end-child.service.js";
import type { SessionEndCoordinator } from "../lifecycle/session-end.coordinator.js";
import type { LifecycleRecoveryCoordinator } from "../lifecycle/lifecycle-recovery.coordinator.js";
import {
  sessionEndGenerationStatusV2,
} from "../lifecycle/session-end-workflow.service.js";
import type { LifecycleFencedOperation } from "../lifecycle/contracts/commands.js";
import type {
  LifecycleOperationalTransaction,
  LifecycleOperationalWorkIdentity,
} from "../lifecycle/lifecycle-operational.store.js";
import type {
  LifecycleOutboxClaimV1,
  LifecycleOutboxMaterializationResultV1,
} from "../storage/lifecycle-storage.types.js";
import type { InternalWorkflowExecutionPlan } from "../lifecycle/contracts/commands.js";
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
import { canonicalJson } from "../serialization/canonical-json.js";

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
  readonly sessionEndChildService?: SessionEndChildService;
  readonly sessionEndCoordinator?: SessionEndCoordinator;
  readonly recoveryCoordinator?: LifecycleRecoveryCoordinator;
  readonly checkpointHandler: PreparedCheckpointLifecycleHandler;
  readonly evidenceHandler: PreparedEvidenceLifecycleHandler;
  readonly queryService: LifecycleQueryService;
  readonly semanticStore: LifecycleCommandStore;
  readonly operationalStore: LifecycleOperationalStore;
  readonly nowMs?: () => bigint;
}

export class ConnectionBoundLifecycleWorkerRuntime
implements LifecycleWorkerRuntime {
  #options: ConnectionBoundLifecycleWorkerRuntimeOptions | null;
  #nowMs: () => bigint = () => BigInt(Date.now());

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
    if (options.nowMs !== undefined) this.#nowMs = options.nowMs;
  }

  configureSessionEndRouting(
    sessionEndChildService: SessionEndChildService,
    sessionEndCoordinator: SessionEndCoordinator,
  ): void {
    const options = this.#options;
    if (options === null || options.sessionEndChildService !== undefined
      || options.sessionEndCoordinator !== undefined
      || typeof sessionEndChildService?.execute !== "function"
      || typeof sessionEndCoordinator?.execute !== "function") {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    this.#options = Object.freeze({
      ...options,
      sessionEndChildService,
      sessionEndCoordinator,
    });
  }

  configureFencingClock(nowMs: () => bigint): void {
    if (this.#options === null || typeof nowMs !== "function") {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    this.#nowMs = nowMs;
  }

  configureRecoveryRouting(recoveryCoordinator: LifecycleRecoveryCoordinator): void {
    const options = this.#options;
    if (options === null || options.recoveryCoordinator !== undefined
      || typeof recoveryCoordinator?.execute !== "function") {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    this.#options = Object.freeze({ ...options, recoveryCoordinator });
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
          return Object.freeze({
            operation: operation.operation,
            nestedContractVersion: lifecycleNestedContractVersion(operation),
            result: Object.freeze({
              kind: "rejected",
              errorCode: "LIFECYCLE_OPERATION_UNAVAILABLE",
            }),
          });
      }
    }

    let nestedContractVersion: ReturnType<typeof lifecycleNestedContractVersion>;
    try {
      nestedContractVersion = lifecycleNestedContractVersion(operation);
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
    }
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
    if (operation.kind === "fenced") {
      return success(this.#executeFenced(options, materialized as never) as unknown as JsonValue);
    }
    if (operation.kind === "internal-semantic") {
      const plan = materialized as InternalWorkflowExecutionPlan;
      if (plan.commandType === "internal-workflow-phase"
        && "plannedAction" in plan
        && plan.plannedAction.action === "carry-forward-child") {
        if (options.sessionEndChildService === undefined) {
          throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
        }
        return success(options.sessionEndChildService.execute(context, plan as never) as unknown as JsonValue);
      }
      if ((plan.commandType === "internal-workflow-phase"
        || plan.commandType === "internal-validation-result")
        && options.sessionEndCoordinator !== undefined) {
        return success(options.sessionEndCoordinator.execute(context, plan) as unknown as JsonValue);
      }
      throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
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
      case "request-session-end":
        if (typeof (options.rootProcessor as unknown as { requestSessionEnd?: unknown }).requestSessionEnd !== "function") {
          return Object.freeze({
            operation: operation.operation,
            nestedContractVersion,
            result: Object.freeze({ kind: "rejected" as const, errorCode: "LIFECYCLE_OPERATION_UNAVAILABLE" as const }),
          });
        }
        return this.#safeSessionEndRoute(operation.operation, nestedContractVersion, () =>
          success(options.rootProcessor.requestSessionEnd(context, materialized as never) as unknown as JsonValue));
      case "amend-session-end":
        if (typeof (options.rootProcessor as unknown as { amendSessionEnd?: unknown }).amendSessionEnd !== "function") {
          return Object.freeze({
            operation: operation.operation,
            nestedContractVersion,
            result: Object.freeze({ kind: "rejected" as const, errorCode: "LIFECYCLE_OPERATION_UNAVAILABLE" as const }),
          });
        }
        return this.#safeSessionEndRoute(operation.operation, nestedContractVersion, () =>
          success(options.rootProcessor.amendSessionEnd(context, materialized as never) as unknown as JsonValue));
      case "cancel-session-end":
        if (typeof (options.rootProcessor as unknown as { cancelSessionEnd?: unknown }).cancelSessionEnd !== "function") {
          return Object.freeze({
            operation: operation.operation,
            nestedContractVersion,
            result: Object.freeze({ kind: "rejected" as const, errorCode: "LIFECYCLE_OPERATION_UNAVAILABLE" as const }),
          });
        }
        return this.#safeSessionEndRoute(operation.operation, nestedContractVersion, () =>
          success(options.rootProcessor.cancelSessionEnd(context, materialized as never) as unknown as JsonValue));
      case "abandon-session":
        if (typeof (options.rootProcessor as unknown as { abandonSession?: unknown }).abandonSession !== "function") {
          return Object.freeze({
            operation: operation.operation,
            nestedContractVersion,
            result: Object.freeze({ kind: "rejected" as const, errorCode: "LIFECYCLE_OPERATION_UNAVAILABLE" as const }),
          });
        }
        return this.#safeSessionEndRoute(operation.operation, nestedContractVersion, () =>
          success(options.rootProcessor.abandonSession(context, materialized as never) as unknown as JsonValue));
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

  #safeSessionEndRoute(
    operation: string,
    nestedContractVersion: number | null,
    route: () => LifecycleWorkerSuccessWire,
  ): LifecycleWorkerSuccessWire {
    try {
      return route();
    } catch (error) {
      // Legacy callers used an intentionally skeletal reserved fixture.  It
      // is not a routable semantic command; keep that boundary rejection
      // while allowing fully decoded commands to reach the owner.
      if (error instanceof LifecycleError && error.code === "LIFECYCLE_INPUT_INVALID") {
        return Object.freeze({
          operation: operation as LifecycleWorkerSuccessWire["operation"],
          nestedContractVersion,
          result: Object.freeze({
            kind: "rejected" as const,
            errorCode: "LIFECYCLE_OPERATION_UNAVAILABLE" as const,
          }),
        }) as LifecycleWorkerSuccessWire;
      }
      throw error;
    }
  }

  #executeFenced(
    options: ConnectionBoundLifecycleWorkerRuntimeOptions,
    operation: LifecycleFencedOperation,
  ): JsonValue {
    if (typeof (operation as unknown as { readonly operation?: unknown })?.operation !== "string") {
      throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
    }
    if (operation.operation === "workflow-claim-next") {
      const work = fencedWorkIdentity(operation);
      const result = options.operationalStore.execute(work, (transaction) => {
        const workflows = (transaction as Extract<
          LifecycleOperationalTransaction,
          { readonly workflows: unknown }
        >).workflows;
        return workflows.claimNext({
          projectId: operation.context.binding.projectId,
          ownerId: operation.ownerId,
          observedNowMs: BigInt(operation.observedNowMs),
          leaseDurationMs: BigInt(operation.ttlMs),
        }) as unknown as JsonValue;
      });
      return wireOperationalResult(result.publicResult);
    }
    if (operation.operation === "workflow-recovery") {
      if (options.recoveryCoordinator !== undefined) {
        const result = options.recoveryCoordinator.execute({
          context: operation.context,
          workId: operation.workId,
          ownerId: operation.ownerId,
          fencingToken: BigInt(operation.fencingToken),
          dueBefore: operation.dueBefore,
          limit: operation.limit,
        });
        return wireOperationalResult(result);
      }
      const work = fencedWorkIdentity(operation);
      const result = options.operationalStore.execute(work, (transaction) => {
        const workflows = (transaction as Extract<
          LifecycleOperationalTransaction,
          { readonly workflows: unknown }
        >).workflows as unknown as {
          readonly recover?: (input: {
            readonly projectId: string;
            readonly dueBefore: string;
            readonly limit: number;
          }) => JsonValue;
        };
        if (typeof workflows.recover !== "function") {
          throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
        }
        return workflows.recover({
          projectId: operation.context.binding.projectId,
          dueBefore: operation.dueBefore,
          limit: operation.limit,
        });
      });
      return wireOperationalResult(result.publicResult);
    }
    if (operation.operation === "outbox-claim-next") {
      const work: LifecycleOperationalWorkIdentity = {
        kind: "outbox-selection",
        projectId: operation.context.binding.projectId,
        workId: operation.workId,
        operation: "claim-next",
        ownerId: operation.ownerId,
      };
      const result = options.operationalStore.execute(work, (transaction) => {
        const outbox = (transaction as Extract<
          LifecycleOperationalTransaction,
          { readonly outbox: unknown }
        >).outbox;
        if (typeof outbox.claimNext !== "function") {
          throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
        }
        const claim = outbox.claimNext({
          projectId: operation.context.binding.projectId,
          ownerId: operation.ownerId,
          observedNowMs: BigInt(operation.observedNowMs),
          leaseDurationMs: BigInt(operation.ttlMs),
        });
        return claim === null ? null : outboxClaimWire(claim);
      });
      return wireOperationalResult(result.publicResult);
    }
    if (!operation.operation.startsWith("workflow-")) {
      if (!operation.operation.startsWith("outbox-")) {
        throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
      }
      const input = operation as Extract<LifecycleFencedOperation, {
        readonly operation: "outbox-claim" | "outbox-renew" | "outbox-materialize" | "outbox-failure";
      }>;
      const work: LifecycleOperationalWorkIdentity = {
        kind: "outbox",
        projectId: input.context.binding.projectId,
        targetKey: input.targetKey,
        materializationRevision: BigInt(input.materializationRevision),
        operation: input.operation === "outbox-claim"
          ? "claim"
          : input.operation === "outbox-renew"
            ? "renew"
            : input.operation === "outbox-materialize"
              ? "materialize"
              : "record-failure",
        ownerId: input.ownerId,
        claimToken: BigInt(input.fencingToken),
      };
      const observedNowMs = this.#nowMs();
      if (typeof observedNowMs !== "bigint" || observedNowMs < 0n) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const result = options.operationalStore.execute(work, (transaction) => {
        const outbox = (transaction as Extract<
          LifecycleOperationalTransaction,
          { readonly outbox: unknown }
        >).outbox;
        switch (input.operation) {
          case "outbox-claim": {
            if (typeof outbox.getExactClaim !== "function") {
              throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
            }
            const claim = outbox.getExactClaim({
              projectId: input.context.binding.projectId,
              targetKey: input.targetKey,
              materializationRevision: BigInt(input.materializationRevision),
              ownerId: input.ownerId,
              claimToken: BigInt(input.fencingToken),
            });
            return claim.claimExpiresAt === input.leaseUntil ? outboxClaimWire(claim) : null;
          }
          case "outbox-renew": {
            if (typeof outbox.renewClaim !== "function") {
              throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
            }
            const renewed = outbox.renewClaim({
              projectId: input.context.binding.projectId,
              targetKey: input.targetKey,
              materializationRevision: BigInt(input.materializationRevision),
              ownerId: input.ownerId,
              claimToken: BigInt(input.fencingToken),
              observedNowMs,
              leaseDurationMs: leaseDuration(input.leaseUntil, observedNowMs),
            });
            if (renewed === null) throw new LifecycleError("EVENT_CONFLICT");
            return outboxClaimWire(renewed);
          }
          case "outbox-materialize":
            if (typeof outbox.materialize !== "function") {
              throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
            }
            return materializationResultWire(outbox.materialize({
              context: input.context,
              projectId: input.context.binding.projectId,
              targetKey: input.targetKey,
              materializationRevision: BigInt(input.materializationRevision),
              ownerId: input.ownerId,
              claimToken: BigInt(input.fencingToken),
            }));
          case "outbox-failure":
            if (typeof outbox.recordFailure !== "function") {
              throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
            }
            return outbox.recordFailure({
              projectId: input.context.binding.projectId,
              targetKey: input.targetKey,
              materializationRevision: BigInt(input.materializationRevision),
              ownerId: input.ownerId,
              claimToken: BigInt(input.fencingToken),
              observedNowMs,
              failureClass: input.retryable ? "retryable" : "permanent",
              safeErrorCode: input.safeErrorCode,
              nextAttemptAt: input.nextAttemptAt,
              attemptCount: BigInt(input.attempt),
            });
        }
      });
      return wireOperationalResult(result.publicResult);
    }
    const input = operation as Extract<LifecycleFencedOperation, {
      readonly operation: "workflow-claim" | "workflow-renew" | "workflow-release" | "workflow-eventless-phase";
    }>;
    const work = fencedWorkIdentity(input);
    const needsObservedNow = input.operation !== "workflow-release";
    const observedNowMs = needsObservedNow ? this.#nowMs() : null;
    if (observedNowMs !== null
      && (typeof observedNowMs !== "bigint" || observedNowMs < 0n)) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    const leaseDurationMs = input.operation === "workflow-claim"
      || input.operation === "workflow-renew"
      ? leaseDuration(input.leaseUntil, observedNowMs!)
      : null;
    const result = options.operationalStore.execute(work, (transaction) => {
      const workflows = (transaction as Extract<
        LifecycleOperationalTransaction,
        { readonly workflows: unknown }
      >).workflows;
      switch (input.operation) {
        case "workflow-claim":
          return workflows.claim({
            projectId: input.context.binding.projectId,
            workflowId: input.workflowId,
            workflowGeneration: input.workflowGeneration,
            ownerId: input.ownerId,
            observedNowMs: observedNowMs!,
            leaseDurationMs: leaseDurationMs!,
          }) as unknown as JsonValue;
        case "workflow-renew":
          return workflows.renew({
            projectId: input.context.binding.projectId,
            workflowId: input.workflowId,
            workflowGeneration: input.workflowGeneration,
            ownerId: input.ownerId,
            claimToken: BigInt(input.fencingToken),
            observedNowMs: observedNowMs!,
            leaseDurationMs: leaseDurationMs!,
          }) as unknown as JsonValue;
        case "workflow-release":
          return workflows.release({
            projectId: input.context.binding.projectId,
            workflowId: input.workflowId,
            workflowGeneration: input.workflowGeneration,
            ownerId: input.ownerId,
            claimToken: BigInt(input.fencingToken),
          });
        case "workflow-eventless-phase": {
          const before = workflows.read(
            input.context.binding.projectId,
            input.workflowId,
          );
          if (before === null) throw new LifecycleError("SESSION_NOT_FOUND");
          let materializationRequired = true;
          if (before.resultJson !== null) {
            const parsed = JSON.parse(before.resultJson) as unknown;
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              const record = parsed as Record<string, unknown>;
              const status = record.status;
              const source = typeof status === "object" && status !== null && !Array.isArray(status)
                ? status as Record<string, unknown>
                : record;
              if (typeof source.materializationRequired === "boolean") {
                materializationRequired = source.materializationRequired;
              }
            }
          }
          const nextStatus = sessionEndGenerationStatusV2({
            current: before,
            priorRootState: before.state === "suspended" ? "suspended" : "active",
            workflowGeneration: before.generation,
            triggeringEventPosition: before.triggeringEventPosition,
            phase: input.nextPhase as import("../lifecycle/contracts/session-end.js").SessionEndPhase,
            evidenceWindowState: before.evidenceWindowState ?? "sealed",
            materializationRequired,
            clearFrozenGroup: false,
          });
          const nextResult = {
            resultVersion: 2 as const,
            action: input.nextPhase === "children-resolved"
              ? "mark-children-resolved" as const
              : "confirm-ending-materialization" as const,
            progressed: true,
            previousPhase: input.expectedPhase as import("../lifecycle/contracts/session-end.js").SessionEndPhase,
            status: nextStatus,
          };
          const advanced = workflows.advanceEventlessPhase({
            projectId: input.context.binding.projectId,
            workflowId: input.workflowId,
            workflowGeneration: input.workflowGeneration,
            expectedPhase: input.expectedPhase as never,
            nextPhase: input.nextPhase as never,
            ownerId: input.ownerId,
            claimToken: BigInt(input.fencingToken),
            observedNowMs: observedNowMs!,
            resultJson: canonicalJson(nextResult),
          });
          const current = workflows.read(
            input.context.binding.projectId,
            input.workflowId,
          );
          if (current === null) throw new LifecycleError("SESSION_NOT_FOUND");
          if (!advanced && current.phase !== input.nextPhase) {
            throw new LifecycleError("EVENT_CONFLICT");
          }
          return {
            resultVersion: 2,
            action: input.nextPhase === "children-resolved"
              ? "mark-children-resolved"
              : "confirm-ending-materialization",
            progressed: advanced,
            previousPhase: input.expectedPhase,
            status: sessionEndGenerationStatusV2({
              current,
              priorRootState: current.state === "suspended" ? "suspended" : "active",
              workflowGeneration: current.generation,
              triggeringEventPosition: current.triggeringEventPosition,
              phase: input.nextPhase as import("../lifecycle/contracts/session-end.js").SessionEndPhase,
              evidenceWindowState: current.evidenceWindowState ?? "sealed",
              materializationRequired,
              clearFrozenGroup: false,
            }),
          };
        }
        default:
          throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
      }
    });
    return wireOperationalResult(result.publicResult);
  }
}

function leaseDuration(leaseUntil: string, observedNowMs: bigint): bigint {
  const milliseconds = Date.parse(leaseUntil);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new LifecycleError("LIFECYCLE_INPUT_INVALID");
  }
  const expiry = BigInt(milliseconds);
  if (expiry <= observedNowMs) throw new LifecycleError("LIFECYCLE_INPUT_INVALID");
  return expiry - observedNowMs;
}

function outboxClaimWire(claim: LifecycleOutboxClaimV1): JsonValue {
  const plan = claim.planned;
  if (claim.claimExpiresAt === null) throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
  if (claim.attemptCount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LifecycleError("INTEGRITY_FAILURE");
  }
  return {
    resultVersion: 1,
    projectId: plan.projectId,
    targetKey: plan.targetKey,
    sessionId: plan.sessionId,
    artifactPath: plan.artifactPath,
    originKind: plan.origin.kind,
    workflowId: plan.origin.kind === "workflow" ? plan.origin.workflowId : null,
    workflowGeneration: plan.origin.kind === "workflow" ? plan.origin.workflowGeneration : null,
    materializationRevision: plan.materializationRevision.toString(),
    triggeringEventPosition: plan.triggeringEventPosition.toString(),
    ownerId: claim.claimOwner,
    claimToken: claim.claimToken.toString(),
    claimExpiresAt: claim.claimExpiresAt,
    attemptCount: Number(claim.attemptCount),
  };
}

function materializationResultWire(result: LifecycleOutboxMaterializationResultV1): JsonValue {
  return {
    resultVersion: 1,
    status: result.status,
    targetKey: result.claim.planned.targetKey,
    artifactPath: result.claim.planned.artifactPath,
    materializationRevision: result.claim.planned.materializationRevision.toString(),
    fingerprint: {
      algorithm: result.claim.planned.nextFingerprint.algorithm,
      schemaVersion: result.claim.planned.nextFingerprint.schemaVersion,
      keyId: result.claim.planned.nextFingerprint.keyId,
      domain: result.claim.planned.nextFingerprint.domain,
      value: result.claim.planned.nextFingerprint.value,
    },
    acknowledged: result.claim.status === "completed",
  };
}

function fencedWorkIdentity(
  input: Extract<LifecycleFencedOperation, {
    readonly operation: "workflow-claim-next" | "workflow-claim" | "workflow-renew" | "workflow-release" | "workflow-eventless-phase" | "workflow-recovery";
  }>,
): LifecycleOperationalWorkIdentity {
  switch (input.operation) {
    case "workflow-claim-next":
      return { kind: "workflow-selection", projectId: input.context.binding.projectId, workId: input.workId, operation: "claim-next", ownerId: input.ownerId };
    case "workflow-claim":
    case "workflow-renew":
    case "workflow-release":
    case "workflow-eventless-phase":
      return {
        kind: "workflow",
        projectId: input.context.binding.projectId,
        workflowId: input.workflowId,
        workflowGeneration: BigInt(input.workflowGeneration),
        operation: input.operation === "workflow-eventless-phase"
          ? "advance-eventless"
          : input.operation.replace("workflow-", "") as "claim" | "renew" | "release",
        ownerId: input.ownerId,
        claimToken: BigInt(input.fencingToken),
      };
    case "workflow-recovery":
      return {
        kind: "workflow-recovery",
        projectId: input.context.binding.projectId,
        workId: input.workId,
        operation: "recovery",
        ownerId: input.ownerId,
        claimToken: BigInt(input.fencingToken),
      };
  }
}

function wireOperationalResult(value: unknown): JsonValue {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
    || (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(wireOperationalResult) as JsonValue;
  if (typeof value !== "object") throw new LifecycleError("INTEGRITY_FAILURE");
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) output[key] = wireOperationalResult(item);
  return output;
}
