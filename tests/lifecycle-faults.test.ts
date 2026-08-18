import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ProjectId } from "../src/orchestrator/identity/contracts.js";
import type {
  SessionId,
  WorkflowId,
} from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import {
  LIFECYCLE_FAULT_POINTS_BY_BOUNDARY,
  NO_LIFECYCLE_FAULTS,
  selectLifecycleFault,
  type LifecycleDurableBoundary,
  type LifecycleExternalFaultPoint,
  type LifecycleFilesystemFaultPoint,
  type LifecycleFaultContext,
  type LifecycleFaultInjector,
  type LifecycleFaultPoint,
  type LifecycleSqliteFaultPoint,
} from "../src/orchestrator/lifecycle/lifecycle-faults.js";

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type _SqlitePointsAreExact = Expect<Equal<
  LifecycleSqliteFaultPoint,
  "before-write" | "after-write-before-commit" | "after-commit-before-response"
>>;
type _ExternalPointsAreExact = Expect<Equal<
  LifecycleExternalFaultPoint,
  "before-external-start" | "after-external-complete-before-result-commit"
>>;
type _FilesystemPointsAreExact = Expect<Equal<
  LifecycleFilesystemFaultPoint,
  "before-temp-write" | "after-temp-fsync-before-replace" | "after-replace-before-ack"
>>;
type _FaultPointsAreExact = Expect<Equal<
  LifecycleFaultPoint,
  LifecycleSqliteFaultPoint | LifecycleExternalFaultPoint | LifecycleFilesystemFaultPoint
>>;
type _DurableBoundariesAreExact = Expect<Equal<
  LifecycleDurableBoundary,
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
  | "response-delivery"
>>;
type _ContextIsExact = Expect<Equal<
  LifecycleFaultContext,
  {
    readonly projectId: ProjectId;
    readonly sessionId: SessionId | null;
    readonly workflowId: WorkflowId | null;
    readonly commandId: string | null;
    readonly idempotencyKeyHash: string | null;
    readonly workId: string | null;
    readonly eventPosition: string | null;
    readonly materializationRevision: string | null;
  }
>>;
type _InjectorIsExact = Expect<Equal<
  LifecycleFaultInjector,
  {
    hit(
      boundary: LifecycleDurableBoundary,
      point: LifecycleFaultPoint,
      context: LifecycleFaultContext,
    ): void;
  }
>>;

const context: LifecycleFaultContext = {
  projectId: "11111111-1111-4111-8111-111111111111" as ProjectId,
  sessionId: null,
  workflowId: null,
  commandId: null,
  idempotencyKeyHash: null,
  workId: null,
  eventPosition: null,
  materializationRevision: null,
};

describe("lifecycle fault contract", () => {
  it("publishes the exact immutable Task 18 fault matrix for all 24 boundaries", () => {
    const sqlite = [
      "before-write",
      "after-write-before-commit",
      "after-commit-before-response",
    ] as const;
    assert.deepEqual(LIFECYCLE_FAULT_POINTS_BY_BOUNDARY, {
      "authority-cas": sqlite,
      "event-append": sqlite,
      "lease-update": sqlite,
      "workflow-create": sqlite,
      "workflow-phase": sqlite,
      "final-checkpoint": sqlite,
      "validation-result": [
        "before-external-start",
        "after-external-complete-before-result-commit",
        ...sqlite,
      ],
      "final-source-state-check": sqlite,
      "outbox-insert": sqlite,
      "outbox-claim": sqlite,
      "temporary-file-write": [
        "before-temp-write",
        "after-temp-fsync-before-replace",
      ],
      "artifact-replace": ["after-replace-before-ack"],
      "materialization-ack": [
        "before-write",
        "after-write-before-commit",
        "after-replace-before-ack",
        "after-commit-before-response",
      ],
      "outbox-failure": sqlite,
      "session-suspend": sqlite,
      "transfer-create": sqlite,
      "transfer-claim": sqlite,
      "ownership-recovery": sqlite,
      "generation-fence": sqlite,
      "cancellation-rewrite": sqlite,
      "abandonment-rewrite": sqlite,
      "verification-event": sqlite,
      "session-ended": sqlite,
      "response-delivery": ["after-commit-before-response"],
    });
    assert.equal(Object.keys(LIFECYCLE_FAULT_POINTS_BY_BOUNDARY).length, 24);
    assert.equal(Object.isFrozen(LIFECYCLE_FAULT_POINTS_BY_BOUNDARY), true);
    for (const points of Object.values(LIFECYCLE_FAULT_POINTS_BY_BOUNDARY)) {
      assert.equal(Object.isFrozen(points), true);
    }
  });

  it("strict-selects only an authoritative boundary and point pair at arm time", () => {
    assert.deepEqual(
      selectLifecycleFault("validation-result", "before-external-start"),
      { boundary: "validation-result", point: "before-external-start" },
    );
    assert.equal(
      Object.isFrozen(selectLifecycleFault("event-append", "before-write")),
      true,
    );
    assert.throws(
      () => selectLifecycleFault("not-a-boundary", "before-write"),
      /LIFECYCLE_FAULT_SELECTION_INVALID/,
    );
    assert.throws(
      () => selectLifecycleFault("artifact-replace", "before-write"),
      /LIFECYCLE_FAULT_SELECTION_INVALID/,
    );
  });

  it("exports the exact fault points, boundaries, context, and injector shape", () => {
    assert.equal(typeof NO_LIFECYCLE_FAULTS.hit, "function");
    assert.equal(
      NO_LIFECYCLE_FAULTS.hit("event-append", "before-write", context),
      undefined,
    );
    assert.equal(
      NO_LIFECYCLE_FAULTS.hit(
        "validation-result",
        "after-external-complete-before-result-commit",
        context,
      ),
      undefined,
    );
    assert.equal(
      NO_LIFECYCLE_FAULTS.hit(
        "artifact-replace",
        "after-replace-before-ack",
        context,
      ),
      undefined,
    );
  });
});
