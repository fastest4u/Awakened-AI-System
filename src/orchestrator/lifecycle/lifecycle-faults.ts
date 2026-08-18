import type { ProjectId } from "../identity/contracts.js";
import type { SessionId, WorkflowId } from "./contracts/identifiers.js";

export type LifecycleSqliteFaultPoint =
  | "before-write"
  | "after-write-before-commit"
  | "after-commit-before-response";

export type LifecycleExternalFaultPoint =
  | "before-external-start"
  | "after-external-complete-before-result-commit";

export type LifecycleFilesystemFaultPoint =
  | "before-temp-write"
  | "after-temp-fsync-before-replace"
  | "after-replace-before-ack";

export type LifecycleFaultPoint =
  | LifecycleSqliteFaultPoint
  | LifecycleExternalFaultPoint
  | LifecycleFilesystemFaultPoint;

export type LifecycleDurableBoundary =
  | "authority-cas"
  | "event-append"
  | "lease-update"
  | "workflow-create"
  | "workflow-phase"
  | "final-checkpoint"
  | "validation-result"
  | "final-source-state-check"
  | "outbox-insert"
  | "outbox-claim"
  | "temporary-file-write"
  | "artifact-replace"
  | "materialization-ack"
  | "outbox-failure"
  | "session-suspend"
  | "transfer-create"
  | "transfer-claim"
  | "ownership-recovery"
  | "generation-fence"
  | "cancellation-rewrite"
  | "abandonment-rewrite"
  | "verification-event"
  | "session-ended"
  | "response-delivery";

export interface LifecycleFaultContext {
  readonly projectId: ProjectId;
  readonly sessionId: SessionId | null;
  readonly workflowId: WorkflowId | null;
  readonly commandId: string | null;
  readonly idempotencyKeyHash: string | null;
  readonly workId: string | null;
  readonly eventPosition: string | null;
  readonly materializationRevision: string | null;
}

export interface LifecycleFaultInjector {
  hit(
    boundary: LifecycleDurableBoundary,
    point: LifecycleFaultPoint,
    context: LifecycleFaultContext,
  ): void;
}

export const NO_LIFECYCLE_FAULTS: LifecycleFaultInjector = Object.freeze({
  hit: (): void => undefined,
});
