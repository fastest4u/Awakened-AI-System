import { randomUUID } from "node:crypto";
import {
  cohortBucket,
  decodeRolloutRevision,
  RolloutControlPlaneError,
  type RolloutMode,
  type RolloutRevision,
} from "./rollout-cohort.js";
import {
  type RolloutControlPlaneTransaction,
  type RolloutControlState,
  type RolloutTransition,
  SqliteRolloutControlPlaneRepository,
} from "../storage/rollout-control-plane.repository.js";

export interface RolloutApproval {
  readonly approvalId: string;
  readonly nonceDigest: string;
  readonly actorFingerprint: string;
  readonly evidenceDigest: string;
  readonly reasonCode: string;
  readonly recordedAt: string;
}

export interface RolloutTransitionRequest {
  readonly projectId: string;
  readonly revisionId: string | null;
  readonly expectedMode: RolloutMode;
  readonly expectedGeneration: bigint;
  readonly nextMode: RolloutMode;
  readonly approval: RolloutApproval;
}

export interface RolloutPromotionGate {
  assertAllowed(input: Readonly<{
    fromMode: RolloutMode;
    nextMode: RolloutMode;
    revision: RolloutRevision | null;
  }>): void;
}

export const V2_ROUTING_DISABLED_GATE: RolloutPromotionGate = Object.freeze({
  assertAllowed({ nextMode }: Readonly<{
    fromMode: RolloutMode;
    nextMode: RolloutMode;
    revision: RolloutRevision | null;
  }>): void {
    if (nextMode !== "off" && nextMode !== "shadow") {
      fail("ROLLOUT_V2_ROUTING_DISABLED");
    }
  },
});

const NEXT_MODES: Readonly<Record<RolloutMode, readonly RolloutMode[]>> = Object.freeze({
  off: Object.freeze(["shadow", "read-only-recovery"] as const),
  shadow: Object.freeze(["off", "canary", "read-only-recovery"] as const),
  canary: Object.freeze(["canary", "primary", "rollback-pending", "read-only-recovery"] as const),
  primary: Object.freeze(["rollback-pending", "read-only-recovery"] as const),
  "rollback-pending": Object.freeze(["off", "read-only-recovery"] as const),
  "read-only-recovery": Object.freeze(["off"] as const),
});

const TRANSITION_REQUEST_KEYS = [
  "projectId",
  "revisionId",
  "expectedMode",
  "expectedGeneration",
  "nextMode",
  "approval",
] as const;
const APPROVAL_KEYS = [
  "approvalId",
  "nonceDigest",
  "actorFingerprint",
  "evidenceDigest",
  "reasonCode",
  "recordedAt",
] as const;
const COHORT_QUERY_KEYS = ["projectId", "revisionId", "workspaceId"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MODES: readonly RolloutMode[] = [
  "off",
  "shadow",
  "canary",
  "primary",
  "rollback-pending",
  "read-only-recovery",
];
const CANARY_SEQUENCE: readonly number[] = Object.freeze([100, 500, 2500, 5000, 10000]);
const MAX_GENERATION = 9223372036854775807n;

interface CanaryCohortQuery {
  readonly projectId: string;
  readonly revisionId: string;
  readonly workspaceId: string;
}

export class RolloutControlPlane {
  public constructor(
    private readonly repository: SqliteRolloutControlPlaneRepository,
    private readonly promotionGate: RolloutPromotionGate = V2_ROUTING_DISABLED_GATE,
  ) {}

  public createRevision(input: unknown): RolloutRevision {
    const revision = decodeRolloutRevision(input);

    return this.repository.transact(revision.projectId, (transaction) => {
      if (transaction.readRevision(revision.revisionId) !== null) {
        fail("ROLLOUT_STATE_CONFLICT");
      }
      if (revision.parentRevisionId !== null) {
        const parent = transaction.readRevision(revision.parentRevisionId);
        if (parent === null) fail("ROLLOUT_TRANSITION_DENIED");
        resolveRoot(transaction, parent);
        assertRevisionEdge(parent, revision, "ROLLOUT_TRANSITION_DENIED");
      }
      transaction.insertRevision(revision);
      return revision;
    });
  }

  public state(projectId: string): RolloutControlState {
    const decodedProjectId = decodeUuidInput(projectId);
    return this.repository.transact(decodedProjectId, (transaction) => transaction.readState());
  }

  public transition(input: unknown): RolloutControlState {
    const request = decodeTransitionRequest(input);

    return this.repository.transact(request.projectId, (transaction) => {
      const current = transaction.readState();
      if (current.mode !== request.expectedMode || current.stateGeneration !== request.expectedGeneration) {
        fail("ROLLOUT_STATE_CONFLICT");
      }
      if (!NEXT_MODES[current.mode].includes(request.nextMode)) {
        fail("ROLLOUT_TRANSITION_DENIED");
      }

      const revision = resolveTransitionRevision(transaction, request);
      assertTransitionRevisionBinding(current, request);
      if (request.nextMode === "canary") {
        assertCanaryTransition(transaction, current, revision);
      }
      if (request.nextMode === "primary") {
        assertPrimaryTransition(current, revision);
      }

      const gateResult: unknown = this.promotionGate.assertAllowed(Object.freeze({
        fromMode: current.mode,
        nextMode: request.nextMode,
        revision,
      }));
      assertSynchronousGateResult(gateResult);

      if (current.stateGeneration === MAX_GENERATION) fail("ROLLOUT_INTEGRITY_FAILURE");
      const nextGeneration = current.stateGeneration + 1n;
      const transition: RolloutTransition = Object.freeze({
        projectId: request.projectId,
        transitionId: randomUUID(),
        revisionId: request.revisionId,
        fromMode: current.mode,
        toMode: request.nextMode,
        priorStateGeneration: current.stateGeneration,
        nextStateGeneration: nextGeneration,
        approvalId: request.approval.approvalId,
        approvalNonceDigest: request.approval.nonceDigest,
        actorFingerprint: request.approval.actorFingerprint,
        evidenceDigest: request.approval.evidenceDigest,
        reasonCode: request.approval.reasonCode,
        recordedAt: request.approval.recordedAt,
      });

      transaction.appendTransition(transition);
      transaction.compareAndSetState(Object.freeze({
        expectedMode: current.mode,
        expectedGeneration: current.stateGeneration,
        revisionId: request.revisionId,
        nextMode: request.nextMode,
        nextGeneration,
        transitionId: transition.transitionId,
        updatedAt: transition.recordedAt,
      }));
      return transaction.readState();
    });
  }

  public isSelectedCanaryCohort(input: unknown): boolean {
    const query = decodeCanaryCohortQuery(input);

    return this.repository.transact(query.projectId, (transaction) => {
      const requested = transaction.readRevision(query.revisionId);
      if (requested === null) fail("ROLLOUT_TRANSITION_DENIED");
      const root = resolveRoot(transaction, requested);
      return cohortBucket(root, Object.freeze({
        projectId: query.projectId,
        workspaceId: query.workspaceId,
      })) < requested.cohortBasisPoints;
    });
  }
}

function assertTransitionRevisionBinding(
  current: RolloutControlState,
  request: RolloutTransitionRequest,
): void {
  if (request.nextMode === "off" || current.mode === "off") return;
  if (current.mode === "canary" && request.nextMode === "canary") return;
  if (current.revisionId === null) fail("ROLLOUT_INTEGRITY_FAILURE");
  if (request.revisionId !== current.revisionId) fail("ROLLOUT_TRANSITION_DENIED");
}

function assertPrimaryTransition(
  current: RolloutControlState,
  revision: RolloutRevision | null,
): void {
  if (
    current.mode !== "canary"
    || current.revisionId === null
    || revision === null
    || revision.revisionId !== current.revisionId
    || revision.cohortBasisPoints !== 10000
  ) {
    fail("ROLLOUT_TRANSITION_DENIED");
  }
}

function assertSynchronousGateResult(value: unknown): void {
  if (value === undefined) return;
  try {
    if (value instanceof Promise) {
      void Promise.prototype.then.call(value, undefined, () => undefined);
    }
  } catch {
    fail("ROLLOUT_INTEGRITY_FAILURE");
  }
  fail("ROLLOUT_INTEGRITY_FAILURE");
}

function resolveTransitionRevision(
  transaction: RolloutControlPlaneTransaction,
  request: RolloutTransitionRequest,
): RolloutRevision | null {
  if (request.nextMode === "off") {
    if (request.revisionId !== null) fail("ROLLOUT_TRANSITION_DENIED");
    return null;
  }
  if (request.revisionId === null) fail("ROLLOUT_TRANSITION_DENIED");
  const revision = transaction.readRevision(request.revisionId);
  if (revision === null) fail("ROLLOUT_TRANSITION_DENIED");
  resolveRoot(transaction, revision);
  return revision;
}

function assertCanaryTransition(
  transaction: RolloutControlPlaneTransaction,
  current: RolloutControlState,
  revision: RolloutRevision | null,
): void {
  if (revision === null || !CANARY_SEQUENCE.includes(revision.cohortBasisPoints)) {
    fail("ROLLOUT_TRANSITION_DENIED");
  }
  if (current.mode !== "canary") {
    if (revision.cohortBasisPoints !== CANARY_SEQUENCE[0]) fail("ROLLOUT_TRANSITION_DENIED");
    return;
  }
  if (current.revisionId === null || revision.parentRevisionId !== current.revisionId) {
    fail("ROLLOUT_TRANSITION_DENIED");
  }
  const currentRevision = transaction.readRevision(current.revisionId);
  if (currentRevision === null) fail("ROLLOUT_INTEGRITY_FAILURE");
  const currentSequenceIndex = CANARY_SEQUENCE.indexOf(currentRevision.cohortBasisPoints);
  if (
    currentSequenceIndex < 0
    || currentSequenceIndex === CANARY_SEQUENCE.length - 1
    || revision.cohortBasisPoints !== CANARY_SEQUENCE[currentSequenceIndex + 1]
  ) {
    fail("ROLLOUT_TRANSITION_DENIED");
  }
}

function resolveRoot(
  transaction: RolloutControlPlaneTransaction,
  requested: RolloutRevision,
): RolloutRevision {
  const projectId = requested.projectId;
  const visited = new Set<string>();
  let child = requested;

  for (;;) {
    if (child.projectId !== projectId || visited.has(child.revisionId)) {
      fail("ROLLOUT_INTEGRITY_FAILURE");
    }
    visited.add(child.revisionId);
    if (child.parentRevisionId === null) return child;
    const parent = transaction.readRevision(child.parentRevisionId);
    if (parent === null || parent.projectId !== projectId) fail("ROLLOUT_INTEGRITY_FAILURE");
    assertRevisionEdge(parent, child, "ROLLOUT_INTEGRITY_FAILURE");
    child = parent;
  }
}

function assertRevisionEdge(
  parent: RolloutRevision,
  child: RolloutRevision,
  code: RolloutControlPlaneError["code"],
): void {
  if (
    child.projectId !== parent.projectId
    || child.cohortAlgorithmVersion !== parent.cohortAlgorithmVersion
    || child.cohortSalt !== parent.cohortSalt
    || child.cohortBasisPoints < parent.cohortBasisPoints
  ) {
    fail(code);
  }
}

function decodeTransitionRequest(input: unknown): RolloutTransitionRequest {
  try {
    const value = strictRecord(input, TRANSITION_REQUEST_KEYS);
    const approval = decodeApproval(value.approval);
    return Object.freeze({
      projectId: uuid(value.projectId),
      revisionId: nullableUuid(value.revisionId),
      expectedMode: mode(value.expectedMode),
      expectedGeneration: generation(value.expectedGeneration),
      nextMode: mode(value.nextMode),
      approval,
    });
  } catch {
    return invalid();
  }
}

function decodeApproval(input: unknown): RolloutApproval {
  const value = strictRecord(input, APPROVAL_KEYS);
  return Object.freeze({
    approvalId: uuid(value.approvalId),
    nonceDigest: hash(value.nonceDigest),
    actorFingerprint: hash(value.actorFingerprint),
    evidenceDigest: hash(value.evidenceDigest),
    reasonCode: reason(value.reasonCode),
    recordedAt: timestamp(value.recordedAt),
  });
}

function decodeCanaryCohortQuery(input: unknown): CanaryCohortQuery {
  try {
    const value = strictRecord(input, COHORT_QUERY_KEYS);
    return Object.freeze({
      projectId: uuid(value.projectId),
      revisionId: uuid(value.revisionId),
      workspaceId: workspaceId(value.workspaceId),
    });
  } catch {
    return invalid();
  }
}

function strictRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) invalid();
  if (Object.getPrototypeOf(input) !== Object.prototype) invalid();
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    invalid();
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function decodeUuidInput(input: unknown): string {
  try {
    return uuid(input);
  } catch {
    return invalid();
  }
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid();
  return value;
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) invalid();
  return value;
}

function mode(value: unknown): RolloutMode {
  if (typeof value !== "string" || !MODES.includes(value as RolloutMode)) invalid();
  return value as RolloutMode;
}

function generation(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_GENERATION) invalid();
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) invalid();
  if (!Number.isFinite(new Date(value).getTime()) || new Date(value).toISOString() !== value) invalid();
  return value;
}

function reason(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid();
  }
  return value;
}

function workspaceId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid();
  }
  return value;
}

function fail(code: RolloutControlPlaneError["code"]): never {
  throw new RolloutControlPlaneError(code);
}

function invalid(): never {
  return fail("ROLLOUT_INPUT_INVALID");
}
