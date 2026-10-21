import type { StoredEvent } from "../contracts/event.js";
import { payloadHash } from "../crypto/event-hash.js";
import type { CapabilityKeyProvider } from "../lifecycle/authority/capability-key-provider.js";
import {
  decodeLifecycleEventPayload,
  type LifecycleEventType,
} from "../lifecycle/contracts/events.js";
import { LifecycleError } from "../lifecycle/errors.js";
import {
  decodeKeyedFingerprintV1,
  decodeMaterializationProjectionInputV1,
  decodePendingLifecycleOutboxV1,
  type ExactPlannedRevisionQuery,
  type LifecycleMaterializationPlanningReads,
  type LifecycleOutboxPlanReader,
  type LifecycleOutboxPlannedRevision,
  type LifecycleRenderTriggerV1,
  type MaterializationProjectionInputV1,
  type PreparedMaterializationQueueV1,
} from "../lifecycle/materialization-queue.port.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { PreparedMaterializationHandleOwner } from "./prepared-materialization-handle.js";
import {
  normalizeCandidateLifecycleRenderEvent,
} from "./lifecycle-render-event.js";
import {
  projectCompatibilityLogV2,
  type CompatibilityLogProjectionInputV2,
} from "./compatibility-log.projection.js";
import {
  renderCompatibilityLogV2,
  type CompatibilityLogProjectionV2,
} from "./compatibility-log.renderer.js";
import {
  deriveCompatibilityLogTarget,
  type CompatibilityLogTargetV1,
} from "./vault-artifact-path.js";

const MATERIALIZATION_FINGERPRINT_DOMAIN = "pm-materialization-fingerprint-v1";
const MATERIALIZATION_FINGERPRINT_PURPOSE = "materialization-fingerprint" as const;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;

export interface LifecycleMaterializationQueueDependencies {
  readonly reads: LifecycleMaterializationPlanningReads;
  readonly keyProvider: Pick<CapabilityKeyProvider, "currentKey" | "fingerprint">;
  readonly planReader: LifecycleOutboxPlanReader;
  readonly deriveTarget?: typeof deriveCompatibilityLogTarget;
  readonly project?: (input: CompatibilityLogProjectionInputV2) => CompatibilityLogProjectionV2;
  readonly render?: (projection: CompatibilityLogProjectionV2) => Buffer;
}

interface QueueFacts {
  readonly input: MaterializationProjectionInputV1;
  readonly candidate: LifecycleRenderTriggerV1;
  readonly target: CompatibilityLogTargetV1;
  readonly pending: PreparedMaterializationQueueV1["pendingOutbox"];
}

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function boundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    return integrity();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) integrity();
  return value as Record<string, unknown>;
}

function positivePosition(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 1n || value > SQLITE_INT64_MAX) integrity();
  return value;
}

function exactQuery(facts: QueueFacts): ExactPlannedRevisionQuery {
  const common = {
    projectId: facts.input.context.binding.projectId,
    sessionId: facts.input.sessionId,
    artifactKind: "compatibility-session-log" as const,
    materializationRevision: facts.input.expectedTriggerPosition,
    triggeringEventPosition: facts.input.expectedTriggerPosition,
  };
  if (facts.input.origin.kind === "workflow") {
    return {
      ...common,
      origin: facts.input.origin,
      triggeringEventType: facts.input.triggeringEventType,
    };
  }
  return {
    ...common,
    origin: facts.input.origin,
    triggeringEventType: "SessionAbandoned",
  };
}

function assertPlannedEvent(facts: QueueFacts, event: StoredEvent): void {
  const candidate = facts.candidate;
  positivePosition(event.globalPosition);
  positivePosition(event.streamVersion);
  if (
    event.globalPosition !== BigInt(candidate.globalPosition)
    || event.streamVersion !== BigInt(candidate.streamVersion)
    || event.projectId !== candidate.projectId
    || event.vaultId !== candidate.vaultId
    || event.storeId !== candidate.storeId
    || event.workspaceId !== candidate.workspaceId
    || event.branchScopeId !== candidate.branchScopeId
    || event.branchRef !== candidate.branchRef
    || event.streamId !== candidate.streamId
    || event.streamType !== "session"
    || event.eventType !== candidate.eventType
    || event.eventSchemaVersion !== candidate.eventSchemaVersion
    || event.sessionId !== candidate.sessionId
    || event.parentSessionId !== candidate.parentSessionId
    || event.commandEventIndex !== facts.input.triggeringEventIndex
    || event.occurredAt !== candidate.occurredAt
  ) integrity();
  const canonicalPayload = canonicalJson(event.payload);
  if (canonicalPayload !== event.payloadJson || payloadHash(event.payload) !== event.payloadHash) integrity();
  let decodedPayload: unknown;
  try {
    decodedPayload = decodeLifecycleEventPayload(
      event.eventType as LifecycleEventType,
      event.eventSchemaVersion,
      event.payload,
    );
  } catch {
    integrity();
  }
  if (canonicalJson(decodedPayload) !== canonicalJson(candidate.payload)) integrity();
  const decodedRecord = record(decodedPayload);
  if (facts.input.origin.kind === "workflow") {
    if (
      decodedRecord.workflowId !== facts.input.origin.workflowId
      || decodedRecord.workflowGeneration !== facts.input.origin.workflowGeneration
    ) integrity();
  } else if (decodedRecord.workflowId !== null || decodedRecord.workflowGeneration !== null) {
    integrity();
  }
}

function assertPlannedRow(
  facts: QueueFacts,
  plan: LifecycleOutboxPlannedRevision,
): void {
  const payload = facts.pending.payload;
  const query = exactQuery(facts);
  if (
    plan.projectId !== query.projectId
    || plan.sessionId !== query.sessionId
    || plan.artifactKind !== query.artifactKind
    || plan.materializationRevision !== query.materializationRevision
    || plan.triggeringEventPosition !== query.triggeringEventPosition
    || plan.triggeringEventType !== query.triggeringEventType
    || canonicalJson(plan.origin) !== canonicalJson(query.origin)
    || plan.targetKey !== payload.targetKey
    || plan.artifactPath !== payload.artifactPath
    || plan.triggeringPayloadHash !== payload.triggeringPayloadHash
    || canonicalJson(plan.nextFingerprint) !== canonicalJson(payload.nextFingerprint)
  ) integrity();
}

/** Connection-bound queue that owns one opaque plan handle and all transient render bytes. */
export class SqliteLifecycleMaterializationQueue {
  readonly #dependencies: LifecycleMaterializationQueueDependencies;
  readonly #owner = new PreparedMaterializationHandleOwner();
  readonly #facts = new WeakMap<object, QueueFacts>();

  constructor(dependencies: LifecycleMaterializationQueueDependencies) {
    this.#dependencies = dependencies;
  }

  prepare(inputValue: MaterializationProjectionInputV1): PreparedMaterializationQueueV1 {
    return boundary(() => {
      const input = decodeMaterializationProjectionInputV1(inputValue);
      const expectedPosition = positivePosition(input.expectedTriggerPosition);
      const tail = this.#dependencies.reads.readGlobalTailPosition();
      if (typeof tail !== "bigint" || tail < 0n || tail >= SQLITE_INT64_MAX || tail + 1n !== expectedPosition) {
        integrity();
      }
      const closure = this.#dependencies.reads.readStrictLifecycleClosure(
        input.context.binding.projectId,
        input.sessionId,
        expectedPosition,
      );
      const started = closure.root[0];
      if (started === undefined) integrity();
      const deriveTarget = this.#dependencies.deriveTarget ?? deriveCompatibilityLogTarget;
      const target = deriveTarget(started.occurredAt, input.sessionId, expectedPosition);
      const candidate = normalizeCandidateLifecycleRenderEvent(input, closure);
      const projectionInput: CompatibilityLogProjectionInputV2 = {
        closure,
        trigger: candidate,
        target,
      };
      const project = this.#dependencies.project ?? projectCompatibilityLogV2;
      const render = this.#dependencies.render ?? renderCompatibilityLogV2;
      const projection = project(projectionInput);
      let renderedBytes: Buffer | null = null;
      try {
        renderedBytes = render(projection);
        if (!(renderedBytes instanceof Uint8Array)) integrity();
        const predecessor = this.#dependencies.reads.readVerifiedImmediatePredecessor(
          input.context.binding.projectId,
          input.sessionId,
          "compatibility-session-log",
          expectedPosition,
        );
        void predecessor;
        const key = this.#dependencies.keyProvider.currentKey(
          {
            projectId: input.context.binding.projectId,
            storeId: input.context.binding.storeId,
          },
          MATERIALIZATION_FINGERPRINT_PURPOSE,
        );
        const fingerprintValue = this.#dependencies.keyProvider.fingerprint({
          projectId: input.context.binding.projectId,
          storeId: input.context.binding.storeId,
          purpose: MATERIALIZATION_FINGERPRINT_PURPOSE,
          keyId: key.keyId,
          domain: MATERIALIZATION_FINGERPRINT_DOMAIN,
          bytes: renderedBytes,
        });
        const nextFingerprint = decodeKeyedFingerprintV1({
          algorithm: "hmac-sha256",
          schemaVersion: 1,
          keyId: key.keyId,
          domain: MATERIALIZATION_FINGERPRINT_DOMAIN,
          value: fingerprintValue,
        });
        const pending = decodePendingLifecycleOutboxV1({
          targetKey: target.targetKey,
          kind: "materialize-lifecycle-log",
          eventIndex: input.triggeringEventIndex,
          payload: {
            payloadVersion: 1,
            targetKey: target.targetKey,
            sessionId: input.sessionId,
            artifactKind: "compatibility-session-log",
            artifactPath: target.artifactPath,
            materializationRevision: target.materializationRevision,
            triggeringPayloadHash: projection.materialization.triggeringPayloadHash,
            nextFingerprint,
            origin: input.origin,
            triggeringEventType: input.triggeringEventType,
          },
        });
        const handle = this.#owner.create(pending);
        this.#facts.set(handle as object, Object.freeze({
          input,
          candidate,
          target,
          pending,
        }));
        return handle;
      } finally {
        if (renderedBytes !== null) renderedBytes.fill(0);
      }
    });
  }

  assertPlanned(
    prepared: PreparedMaterializationQueueV1,
    plannedTrigger: StoredEvent,
  ): void {
    boundary(() => {
      const facts = this.#facts.get(prepared as object);
      if (facts === undefined) integrity();
      this.#owner.capturePlanned(prepared, plannedTrigger, (event) => {
        assertPlannedEvent(facts, event);
      });
    });
  }

  assertCommitted(
    prepared: PreparedMaterializationQueueV1,
    committedTrigger: StoredEvent,
  ): LifecycleOutboxPlannedRevision {
    return boundary(() => {
      const facts = this.#facts.get(prepared as object);
      if (facts === undefined) integrity();
      let committedPlan: LifecycleOutboxPlannedRevision | undefined;
      this.#owner.consumeCommitted(prepared, committedTrigger, (event) => {
        assertPlannedEvent(facts, event);
        committedPlan = this.#dependencies.planReader.assertExactPlannedRevision(exactQuery(facts));
        assertPlannedRow(facts, committedPlan);
      });
      this.#facts.delete(prepared as object);
      if (committedPlan === undefined) integrity();
      return committedPlan;
    });
  }
}
