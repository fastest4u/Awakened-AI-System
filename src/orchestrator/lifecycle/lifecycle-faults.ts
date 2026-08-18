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

const SQLITE_FAULT_POINTS = Object.freeze([
  "before-write",
  "after-write-before-commit",
  "after-commit-before-response",
] as const satisfies readonly LifecycleSqliteFaultPoint[]);

/** The Task 18 oracle. Unsupported Cartesian boundary/point pairs do not exist. */
export const LIFECYCLE_FAULT_POINTS_BY_BOUNDARY = Object.freeze({
  "authority-cas": SQLITE_FAULT_POINTS,
  "event-append": SQLITE_FAULT_POINTS,
  "lease-update": SQLITE_FAULT_POINTS,
  "workflow-create": SQLITE_FAULT_POINTS,
  "workflow-phase": SQLITE_FAULT_POINTS,
  "final-checkpoint": SQLITE_FAULT_POINTS,
  "validation-result": Object.freeze([
    "before-external-start",
    "after-external-complete-before-result-commit",
    ...SQLITE_FAULT_POINTS,
  ] as const),
  "final-source-state-check": SQLITE_FAULT_POINTS,
  "outbox-insert": SQLITE_FAULT_POINTS,
  "outbox-claim": SQLITE_FAULT_POINTS,
  "temporary-file-write": Object.freeze([
    "before-temp-write",
    "after-temp-fsync-before-replace",
  ] as const),
  "artifact-replace": Object.freeze(["after-replace-before-ack"] as const),
  "materialization-ack": Object.freeze([
    "before-write",
    "after-write-before-commit",
    "after-replace-before-ack",
    "after-commit-before-response",
  ] as const),
  "outbox-failure": SQLITE_FAULT_POINTS,
  "session-suspend": SQLITE_FAULT_POINTS,
  "transfer-create": SQLITE_FAULT_POINTS,
  "transfer-claim": SQLITE_FAULT_POINTS,
  "ownership-recovery": SQLITE_FAULT_POINTS,
  "generation-fence": SQLITE_FAULT_POINTS,
  "cancellation-rewrite": SQLITE_FAULT_POINTS,
  "abandonment-rewrite": SQLITE_FAULT_POINTS,
  "verification-event": SQLITE_FAULT_POINTS,
  "session-ended": SQLITE_FAULT_POINTS,
  "response-delivery": Object.freeze(["after-commit-before-response"] as const),
} satisfies Readonly<Record<LifecycleDurableBoundary, readonly LifecycleFaultPoint[]>>);

export interface LifecycleFaultSelection {
  readonly boundary: LifecycleDurableBoundary;
  readonly point: LifecycleFaultPoint;
}

export function isLifecycleDurableBoundary(value: unknown): value is LifecycleDurableBoundary {
  return typeof value === "string"
    && Object.hasOwn(LIFECYCLE_FAULT_POINTS_BY_BOUNDARY, value);
}

export function isLifecycleFaultSelection(
  boundary: unknown,
  point: unknown,
): boundary is LifecycleDurableBoundary {
  if (!isLifecycleDurableBoundary(boundary) || typeof point !== "string") return false;
  return (LIFECYCLE_FAULT_POINTS_BY_BOUNDARY[boundary] as readonly string[]).includes(point);
}

/** Strict fixture arming: reject unknown labels and unsupported pairs immediately. */
export function selectLifecycleFault(
  boundary: unknown,
  point: unknown,
): LifecycleFaultSelection {
  if (!isLifecycleFaultSelection(boundary, point)) {
    throw new Error("LIFECYCLE_FAULT_SELECTION_INVALID");
  }
  return Object.freeze({ boundary, point: point as LifecycleFaultPoint });
}

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
