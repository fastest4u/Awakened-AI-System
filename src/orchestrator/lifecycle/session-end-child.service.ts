import { createHash } from "node:crypto";
import type {
  JsonValue,
  LifecycleReplayExpectation,
  PendingEvent,
  PersistedLifecycleAuthorizationRecord,
} from "../contracts/event.js";
import type { ProjectContext, ProjectId } from "../identity/contracts.js";
import type {
  ChildTransferTicketInsert,
  LifecycleJsonValue,
  SessionAuthorityMutation,
  SessionAuthorityRecord,
  SessionEndCarryForwardTicketLineageV1,
} from "../storage/lifecycle-storage.types.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import type { ChildTransferTicketRecord } from "../storage/lifecycle-storage.types.js";
import { PREVIOUS_PENDING_EVENT_CAUSATION } from "../storage/event-append-transaction.js";
import type { ChildTransferRepository } from "../storage/child-transfer.repository.js";
import type { SessionAuthorityRepository } from "../storage/session-authority.repository.js";
import {
  authorityCommitment,
  type CommittedAuthorityV1,
} from "./authority/authority-commitment.js";
import type {
  CarryForwardChildActionV1,
  InternalCarryForwardChildPlanV1,
} from "./contracts/commands.js";
import type {
  Checkpoint,
} from "./contracts/checkpoint.js";
import type {
  CarryForwardChildResultV1,
} from "./contracts/session-end.js";
import type { LifecycleEventCodecResult } from "./contracts/events.js";
import type {
  ChildSessionState,
  SessionId,
  WorkflowId,
} from "./contracts/identifiers.js";
import { LifecycleError } from "./errors.js";
import {
  LifecycleCommandStore,
  type LifecycleCommandTransaction,
  type PreparedLifecycleCommit,
} from "./lifecycle-command.store.js";
import { buildLifecycleIntentWitness } from "./lifecycle-intent-witness.js";
import { MAX_ROOT_CHILD_HISTORY_V1, sessionEndAutomaticTransferTicketId } from "./session-end-identifiers.js";
import { canonicalJson } from "../serialization/canonical-json.js";

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const LOWER_HASH = /^[0-9a-f]{64}$/u;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SUSPENDED_INTERVENING_EVENTS = new Set([
  "SessionCheckpointRecorded",
  "EvidenceCoverageRecorded",
  "ChildAssignmentAmended",
  "ChildWorkReported",
]);

interface ChildAuthorityOperations {
  get(projectId: string, sessionId: string): SessionAuthorityRecord | null;
  compareAndSwap(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly expectedState: ChildSessionState;
    readonly expectedOwnerGeneration: null;
    readonly expectedChildCapabilityGeneration: bigint | null;
    readonly expectedAuthorityCommitment: string;
    readonly next: SessionAuthorityMutation;
  }): boolean;
  latestCheckpoint(input: SessionAuthorityRecord): Checkpoint | null;
  nextGlobalPosition(): bigint;
  loadEvents(input: SessionAuthorityRecord): readonly LifecycleEventCodecResult[];
  requireFoldMatch(input: SessionAuthorityRecord): import("./session-aggregate.js").SessionAggregateState;
  listNonterminalChildren(projectId: string, rootSessionId: string): readonly SessionAuthorityRecord[];
  listChildHistoryBounded?: (
    projectId: string,
    rootSessionId: string,
    limit: number,
  ) => readonly SessionAuthorityRecord[];
}

interface ChildTransferOperations {
  get(projectId: string, transferTicketId: string): ChildTransferTicketRecord | null;
  listBySourceRoot?: (
    projectId: string,
    sourceRootSessionId: string,
    limit: number,
  ) => readonly ChildTransferTicketRecord[];
  insert(input: ChildTransferTicketInsert): void;
}

interface WorkflowOperations {
  read(projectId: string, workflowId: string): import("../storage/session-end.repository.js").SessionEndWorkflowRecordV1 | null;
}

function invalid(code: "LIFECYCLE_INPUT_INVALID" | "INTEGRITY_FAILURE" = "LIFECYCLE_INPUT_INVALID"): never {
  throw new LifecycleError(code);
}

function conflict(): never {
  throw new LifecycleError("EVENT_CONFLICT");
}

function ownMethod<T extends (...arguments_: never[]) => unknown>(value: object, name: string): T {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
    || typeof descriptor.value !== "function") invalid("INTEGRITY_FAILURE");
  return descriptor.value as T;
}

function optionalOwnMethod<T extends (...arguments_: never[]) => unknown>(value: object, name: string): T | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "function") {
    invalid("INTEGRITY_FAILURE");
  }
  return descriptor.value as T;
}

function authorityOperations(transaction: LifecycleCommandTransaction): ChildAuthorityOperations {
  const value = transaction.authority as object;
  const listChildHistoryBounded = optionalOwnMethod<NonNullable<ChildAuthorityOperations["listChildHistoryBounded"]>>(
    value,
    "listChildHistoryBounded",
  );
  return Object.freeze({
    get: ownMethod<ChildAuthorityOperations["get"]>(value, "get"),
    compareAndSwap: ownMethod<ChildAuthorityOperations["compareAndSwap"]>(value, "compareAndSwap"),
    latestCheckpoint: ownMethod<ChildAuthorityOperations["latestCheckpoint"]>(value, "latestCheckpoint"),
    nextGlobalPosition: ownMethod<ChildAuthorityOperations["nextGlobalPosition"]>(value, "nextGlobalPosition"),
    loadEvents: ownMethod<ChildAuthorityOperations["loadEvents"]>(value, "loadEvents"),
    requireFoldMatch: ownMethod<ChildAuthorityOperations["requireFoldMatch"]>(value, "requireFoldMatch"),
    listNonterminalChildren: ownMethod<ChildAuthorityOperations["listNonterminalChildren"]>(
      value,
      "listNonterminalChildren",
    ),
    ...(listChildHistoryBounded === undefined ? {} : { listChildHistoryBounded }),
  });
}

function transferOperations(transaction: LifecycleCommandTransaction): ChildTransferOperations {
  const value = transaction.transfers as object;
  const listBySourceRoot = optionalOwnMethod<NonNullable<ChildTransferOperations["listBySourceRoot"]>>(
    value,
    "listBySourceRoot",
  );
  return Object.freeze({
    get: ownMethod<ChildTransferOperations["get"]>(value, "get"),
    insert: ownMethod<ChildTransferOperations["insert"]>(value, "insert"),
    ...(listBySourceRoot === undefined ? {} : { listBySourceRoot }),
  });
}

function workflowOperations(transaction: LifecycleCommandTransaction): WorkflowOperations {
  const value = transaction.workflows as object;
  return Object.freeze({
    read: ownMethod<WorkflowOperations["read"]>(value, "read"),
  });
}

function exactNow(clock: { nowMs(): bigint }): { readonly milliseconds: bigint; readonly timestamp: string } {
  const milliseconds = clock.nowMs();
  if (typeof milliseconds !== "bigint" || milliseconds < 0n || milliseconds > 253_402_300_799_999n) invalid();
  return Object.freeze({ milliseconds, timestamp: new Date(Number(milliseconds)).toISOString() });
}

function pendingEvent(
  eventType: string,
  eventSchemaVersion: 1 | 2,
  sessionId: string,
  parentSessionId: string,
  occurredAt: string,
  payload: JsonValue,
  causationId?: string,
): PendingEvent {
  return {
    eventType,
    eventSchemaVersion,
    occurredAt,
    visibilityScope: "session",
    sessionId,
    parentSessionId,
    ...(causationId === undefined ? {} : { causationId }),
    confidence: "high",
    verificationStatus: "verified",
    payload,
    sourceRefs: [],
    evidenceRefs: [],
    evidenceDigests: [],
  };
}

function latestEventId(events: readonly LifecycleEventCodecResult[]): string {
  const event = events.at(-1);
  if (event === undefined) invalid("INTEGRITY_FAILURE");
  return event.eventId;
}

function authorityMutation(record: SessionAuthorityRecord): SessionAuthorityMutation {
  const {
    projectId: _projectId,
    sessionId: _sessionId,
    streamId: _streamId,
    sessionKind: _sessionKind,
    parentSessionId: _parentSessionId,
    workspaceId: _workspaceId,
    clientNamespace: _clientNamespace,
    createdAt: _createdAt,
    ...mutation
  } = record;
  return mutation;
}

function committedAuthority(record: SessionAuthorityRecord): CommittedAuthorityV1 {
  return {
    authorityVersion: 1,
    projectId: record.projectId,
    sessionId: record.sessionId,
    sessionKind: record.sessionKind,
    parentSessionId: record.parentSessionId,
    workspaceId: record.workspaceId,
    clientNamespace: record.clientNamespace,
    ownerGeneration: record.ownerGeneration?.toString() ?? null,
    childCapabilityGeneration: record.childCapabilityGeneration?.toString() ?? null,
    directAccessEnabled: record.directAccessEnabled,
    continuityFingerprintAlgorithm: record.continuityFingerprintAlgorithm,
    continuityFingerprintSchemaVersion: record.continuityFingerprintSchemaVersion,
    continuityFingerprintKeyId: record.continuityFingerprintKeyId,
    continuityFingerprintDomain: record.continuityFingerprintDomain,
    continuityFingerprint: record.continuityFingerprint,
    rootHandleCapabilityVersion: record.rootHandleCapabilityVersion,
    rootHandleKeyId: record.rootHandleKeyId,
    rootHandleIssueNonce: record.rootHandleIssueNonce,
    rootHandleIssuedAt: record.rootHandleIssuedAt,
    rootHandlePolicyCode: record.rootHandlePolicyCode,
    rootHandleExpiryKind: record.rootHandleExpiryKind,
    rootHandleExpiresAt: record.rootHandleExpiresAt,
    rootHandleActorRole: record.rootHandleActorRole,
    rootHandleClientInstanceId: record.rootHandleClientInstanceId,
    rootHandleVerifier: record.rootHandleVerifier,
    resumeTokenCapabilityVersion: record.resumeTokenCapabilityVersion,
    resumeTokenKeyId: record.resumeTokenKeyId,
    resumeTokenIssueNonce: record.resumeTokenIssueNonce,
    resumeTokenIssuedAt: record.resumeTokenIssuedAt,
    resumeTokenPolicyCode: record.resumeTokenPolicyCode,
    resumeTokenExpiryKind: record.resumeTokenExpiryKind,
    resumeTokenExpiresAt: record.resumeTokenExpiresAt,
    resumeTokenActorRole: record.resumeTokenActorRole,
    resumeTokenVerifier: record.resumeTokenVerifier,
    childHandleCapabilityVersion: record.childHandleCapabilityVersion,
    childHandleKeyId: record.childHandleKeyId,
    childHandleIssueNonce: record.childHandleIssueNonce,
    childHandleIssuedAt: record.childHandleIssuedAt,
    childHandlePolicyCode: record.childHandlePolicyCode,
    childHandleExpiryKind: record.childHandleExpiryKind,
    childHandleExpiresAt: record.childHandleExpiresAt,
    childHandleActorRole: record.childHandleActorRole,
    childHandleClientInstanceId: record.childHandleClientInstanceId,
    childHandleVerifier: record.childHandleVerifier,
    revocationReasonCode: record.revocationReasonCode,
    revocationEventPosition: record.revocationEventPosition?.toString() ?? null,
    revokedAt: record.revokedAt,
    terminalEventPosition: record.terminalEventPosition?.toString() ?? null,
    terminalEventType: record.terminalEventType,
    terminalAt: record.terminalAt,
  };
}

function checkpointFingerprint(checkpoint: Checkpoint): string {
  return createHash("sha256")
    .update(`project-memory/checkpoint/v${checkpoint.checkpointVersion}\n`, "utf8")
    .update(canonicalJson(checkpoint), "utf8")
    .digest("hex");
}

function jsonSnapshot(value: unknown): LifecycleJsonValue {
  try {
    return JSON.parse(canonicalJson(value)) as LifecycleJsonValue;
  } catch {
    invalid("INTEGRITY_FAILURE");
  }
}

function summaryList(value: readonly { readonly summary: string }[]): readonly string[] {
  return Object.freeze(value.map((item) => item.summary));
}

function compareBinary(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** Selects the one eligible child using the protocol's binary UUID order. */
export function selectEligibleChild(
  children: readonly SessionAuthorityRecord[],
): SessionAuthorityRecord | null {
  const eligible = children
    .filter((child) => child.sessionKind === "child"
      && child.terminalEventPosition === null
      && (child.semanticState === "active"
        || child.semanticState === "completion-proposed"
        || child.semanticState === "suspended"))
    .sort((left, right) => compareBinary(left.sessionId, right.sessionId));
  return eligible[0] === undefined ? null : Object.freeze({ ...eligible[0] });
}

function exactLineage(value: unknown): SessionEndCarryForwardTicketLineageV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("INTEGRITY_FAILURE");
  const keys = [
    "lineageKind", "workflowId", "workflowGeneration", "plannedWorkId",
    "previousParentSessionId", "previousChildSessionId", "correlationId",
    "suspensionEventPosition", "checkpointEventPosition", "transferEventPosition",
  ] as const;
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key as never))) {
    invalid("INTEGRITY_FAILURE");
  }
  const record = value as Record<string, unknown>;
  if (record.lineageKind !== "session-end-carry-forward-v1"
    || typeof record.workflowId !== "string" || !LOWER_UUID.test(record.workflowId)
    || typeof record.workflowGeneration !== "number"
    || !Number.isSafeInteger(record.workflowGeneration) || record.workflowGeneration < 1
    || typeof record.plannedWorkId !== "string" || !LOWER_HASH.test(record.plannedWorkId)
    || typeof record.previousParentSessionId !== "string" || !LOWER_UUID.test(record.previousParentSessionId)
    || typeof record.previousChildSessionId !== "string" || !LOWER_UUID.test(record.previousChildSessionId)
    || record.previousParentSessionId === record.previousChildSessionId
    || typeof record.correlationId !== "string" || !LOWER_UUID.test(record.correlationId)
    || typeof record.suspensionEventPosition !== "string" || !/^[1-9][0-9]*$/u.test(record.suspensionEventPosition)
    || typeof record.checkpointEventPosition !== "string" || !/^[1-9][0-9]*$/u.test(record.checkpointEventPosition)
    || typeof record.transferEventPosition !== "string" || !/^[1-9][0-9]*$/u.test(record.transferEventPosition)) {
    invalid("INTEGRITY_FAILURE");
  }
  const lineage = Object.freeze({
    lineageKind: "session-end-carry-forward-v1" as const,
    workflowId: record.workflowId as WorkflowId,
    workflowGeneration: record.workflowGeneration,
    plannedWorkId: record.plannedWorkId,
    previousParentSessionId: record.previousParentSessionId as SessionId,
    previousChildSessionId: record.previousChildSessionId as SessionId,
    correlationId: record.correlationId,
    suspensionEventPosition: record.suspensionEventPosition,
    checkpointEventPosition: record.checkpointEventPosition,
    transferEventPosition: record.transferEventPosition,
  });
  if (BigInt(lineage.transferEventPosition) <= BigInt(lineage.suspensionEventPosition)) invalid("INTEGRITY_FAILURE");
  return lineage;
}

export function decodeSessionEndCarryForwardTicketLineageV1(
  value: unknown,
): SessionEndCarryForwardTicketLineageV1 {
  return exactLineage(value);
}

function suspensionWitness(
  events: readonly LifecycleEventCodecResult[],
  position: bigint,
  child: SessionAuthorityRecord,
): Extract<LifecycleEventCodecResult, { readonly eventType: "ChildSessionSuspended" }> {
  const matches = events.filter((event) => event.eventType === "ChildSessionSuspended"
    && BigInt(event.globalPosition) === position);
  if (matches.length !== 1) invalid("INTEGRITY_FAILURE");
  const witness = matches[0];
  if (witness === undefined || witness.eventType !== "ChildSessionSuspended"
    || witness.sessionId !== child.sessionId || witness.parentSessionId !== child.parentSessionId) {
    invalid("INTEGRITY_FAILURE");
  }
  return witness;
}

function assertHistoryCapacity(
  authority: ChildAuthorityOperations,
  transfers: ChildTransferOperations,
  root: SessionAuthorityRecord,
): void {
  const children = authority.listChildHistoryBounded?.(
    root.projectId,
    root.sessionId,
    MAX_ROOT_CHILD_HISTORY_V1 + 1,
  );
  if (children !== undefined && children.length > MAX_ROOT_CHILD_HISTORY_V1) {
    throw new LifecycleError("CHECKPOINT_CAPACITY_EXCEEDED");
  }
  const tickets = transfers.listBySourceRoot?.(
    root.projectId,
    root.sessionId,
    MAX_ROOT_CHILD_HISTORY_V1 + 1,
  );
  if (tickets !== undefined && tickets.length > MAX_ROOT_CHILD_HISTORY_V1) {
    throw new LifecycleError("CHECKPOINT_CAPACITY_EXCEEDED");
  }
}

function assertContext(context: ProjectContext, plan: InternalCarryForwardChildPlanV1): void {
  const binding = context?.binding;
  if (binding === undefined
    || binding.projectId !== plan.expectedProjectId
    || binding.vaultId !== plan.expectedVaultId
    || binding.workspaceId !== plan.expectedWorkspaceId
    || context.workspace !== binding.workspace
    || context.workspace.workspaceId !== binding.workspaceId) {
    throw new LifecycleError("PROJECT_BINDING_REQUIRED");
  }
  const branchRef = context.workspace.kind === "git" ? context.workspace.branchRef : null;
  if (plan.expectedBranchRef !== branchRef) throw new LifecycleError("WORKSPACE_AMBIGUOUS");
}

function assertWorkflowClaim(
  context: ProjectContext,
  plan: InternalCarryForwardChildPlanV1,
  workflow: import("../storage/session-end.repository.js").SessionEndWorkflowRecordV1,
  now: string,
): void {
  if (workflow.projectId !== context.binding.projectId
    || workflow.workflowId !== plan.workflowId
    || workflow.sessionId !== plan.plannedAction.rootSessionId
    || workflow.generation !== plan.workflowGeneration
    || workflow.phase !== "requested"
    || workflow.coordinatorOwnerId !== plan.claim.claimOwnerId
    || workflow.coordinatorClaimToken !== BigInt(plan.claim.claimToken)
    || workflow.coordinatorClaimExpiresAt !== plan.claim.claimExpiresAt
    || Date.parse(workflow.coordinatorClaimExpiresAt ?? "") <= Date.parse(now)) {
    throw new LifecycleError("SESSION_END_INCOMPLETE");
  }
}

function assertPlanMatchesChild(
  authority: ChildAuthorityOperations,
  action: CarryForwardChildActionV1,
  child: SessionAuthorityRecord,
): {
  readonly aggregate: import("./session-aggregate.js").ChildAggregateState;
  readonly checkpoint: Checkpoint;
  readonly events: readonly LifecycleEventCodecResult[];
  readonly suspension: Extract<LifecycleEventCodecResult, { readonly eventType: "ChildSessionSuspended" }> | null;
} {
  if (child.sessionKind !== "child" || child.parentSessionId !== action.rootSessionId
    || child.terminalEventPosition !== null
    || child.semanticState !== action.expectedChildState
    || child.authorityCommitment !== action.expectedChildAuthorityCommitment
    || (child.childCapabilityGeneration?.toString() ?? "0") !== action.expectedChildCapabilityGeneration) {
    conflict();
  }
  const aggregate = authority.requireFoldMatch(child);
  if (aggregate.kind !== "child"
    || aggregate.parentSessionId !== action.rootSessionId
    || aggregate.state !== action.expectedChildState
    || aggregate.eventPosition !== BigInt(action.expectedChildHeadEventPosition)
    || aggregate.streamVersion !== BigInt(action.expectedChildStreamVersion)
    || aggregate.authorityCommitment !== action.expectedChildAuthorityCommitment) conflict();
  const checkpoint = authority.latestCheckpoint(child);
  if (checkpoint === null
    || checkpoint.checkpointId !== action.checkpointId
    || BigInt(checkpoint.checkpointEventPosition) !== BigInt(action.checkpointEventPosition)
    || checkpointFingerprint(checkpoint) !== action.checkpointFingerprint
    || aggregate.latestCheckpointId !== action.checkpointId
    || aggregate.latestCheckpointEventPosition !== BigInt(action.checkpointEventPosition)) conflict();
  const events = authority.loadEvents(child);
  let suspension: Extract<LifecycleEventCodecResult, { readonly eventType: "ChildSessionSuspended" }> | null = null;
  if (action.expectedChildState === "suspended") {
    if (action.expectedSuspensionEventPosition === null || aggregate.suspensionCheckpointId === null) conflict();
    suspension = suspensionWitness(events, BigInt(action.expectedSuspensionEventPosition), child);
    if (suspension.payload.checkpointId !== aggregate.suspensionCheckpointId
      || BigInt(suspension.globalPosition) >= aggregate.eventPosition) invalid("INTEGRITY_FAILURE");
    const index = events.findIndex((event) => event.eventId === suspension!.eventId);
    for (const event of events.slice(index + 1)) {
      if (event.eventType === "ChildWorkTransferCreated" || !SUSPENDED_INTERVENING_EVENTS.has(event.eventType)) {
        invalid("INTEGRITY_FAILURE");
      }
    }
  } else {
    if (action.expectedSuspensionEventPosition !== null || aggregate.suspensionCheckpointId !== null) conflict();
  }
  return { aggregate, checkpoint, events, suspension };
}

function transferredAuthority(
  child: SessionAuthorityRecord,
  eventPosition: bigint,
  now: string,
): SessionAuthorityRecord {
  const provisional: SessionAuthorityRecord = {
    ...child,
    semanticState: "transferred",
    authorityEventPosition: eventPosition,
    revocationReasonCode: "child-transferred",
    revocationEventPosition: eventPosition,
    revokedAt: now,
    terminalEventPosition: eventPosition,
    terminalEventType: "ChildWorkTransferCreated",
    terminalAt: now,
    updatedAt: now,
  };
  return Object.freeze({
    ...provisional,
    authorityCommitment: authorityCommitment(committedAuthority(provisional)),
  });
}

export interface SessionEndChildServiceOptions {
  readonly connection: SqliteConnection;
  readonly commandStore: LifecycleCommandStore;
  readonly authorityRepository: SessionAuthorityRepository;
  readonly transferRepository: ChildTransferRepository;
  readonly clock: { nowMs(): bigint };
}

export class SessionEndChildService {
  readonly #store: LifecycleCommandStore;
  readonly #clock: { nowMs(): bigint };

  constructor(options: SessionEndChildServiceOptions) {
    this.#store = options.commandStore;
    this.#clock = options.clock;
  }

  execute(
    context: ProjectContext,
    plan: InternalCarryForwardChildPlanV1,
  ): CarryForwardChildResultV1 {
    assertContext(context, plan);
    const action = plan.plannedAction;
    const presenting = Object.freeze({
      actorRole: context.binding.actorRole,
      clientInstanceId: context.binding.clientInstanceId,
    });
    const replayExpectation: Extract<LifecycleReplayExpectation, { readonly kind: "internal-workflow" }> = Object.freeze({
      kind: "internal-workflow",
      workflowId: plan.workflowId,
      workflowGeneration: BigInt(plan.workflowGeneration),
      plannedWorkId: plan.plannedWorkId,
      authorizationSessionId: action.rootSessionId,
      targetSessionId: action.childSessionId,
      presenting,
      target: presenting,
    });
    const authorizationRecord: Extract<
      PersistedLifecycleAuthorizationRecord,
      { readonly kind: "internal-workflow" }
    > = Object.freeze({
      ...replayExpectation,
      claimOwnerId: plan.claim.claimOwnerId,
      claimToken: BigInt(plan.claim.claimToken),
    });
    const assertions = {
      authorizationKind: "internal-workflow" as const,
      authorizationSessionId: action.rootSessionId,
      targetSessionId: action.childSessionId,
      projectId: context.binding.projectId,
      vaultId: context.binding.vaultId,
      storeId: context.binding.storeId,
      workspaceId: context.binding.workspaceId,
      clientNamespace: context.binding.clientNamespace,
      capabilityKind: null,
      capabilityGeneration: null,
      presentingActorRole: presenting.actorRole,
      presentingClientInstanceId: presenting.clientInstanceId,
      targetActorRole: presenting.actorRole,
      targetClientInstanceId: presenting.clientInstanceId,
      internalWorkflowId: plan.workflowId,
      internalWorkflowGeneration: plan.workflowGeneration,
      internalPlannedWorkId: plan.plannedWorkId,
    };
    const authoritative = buildLifecycleIntentWitness(plan, assertions);
    const execution = this.#store.execute<CarryForwardChildResultV1>({
      context,
      commandId: plan.commandId,
      idempotencyKey: plan.idempotencyKey,
      commandType: plan.commandType,
      candidateIntentHash: authoritative.intentHash,
      authoritativeIntentHash: authoritative.intentHash,
      semanticCommand: plan,
      capabilityKind: null,
      capabilityGeneration: null,
      replayExpectation,
    }, (transaction) => this.#carryForward(
      transaction,
      context,
      plan,
      authorizationRecord,
    ));
    return execution.publicResult;
  }

  #carryForward(
    transaction: LifecycleCommandTransaction,
    context: ProjectContext,
    plan: InternalCarryForwardChildPlanV1,
    authorizationRecord: Extract<PersistedLifecycleAuthorizationRecord, { readonly kind: "internal-workflow" }>,
  ): PreparedLifecycleCommit<CarryForwardChildResultV1> {
    const authority = authorityOperations(transaction);
    const transfers = transferOperations(transaction);
    const workflows = workflowOperations(transaction);
    const now = exactNow(this.#clock);
    const workflow = workflows.read(context.binding.projectId, plan.workflowId);
    if (workflow === null) throw new LifecycleError("SESSION_NOT_FOUND");
    assertWorkflowClaim(context, plan, workflow, now.timestamp);
    const rootObserved = authority.get(context.binding.projectId, plan.plannedAction.rootSessionId);
    if (rootObserved === null) throw new LifecycleError("SESSION_NOT_FOUND");
    const root = Object.freeze({ ...rootObserved });
    if (root.sessionKind !== "root" || root.parentSessionId !== null || root.semanticState !== "ending") conflict();
    const rootAggregate = authority.requireFoldMatch(root);
    if (rootAggregate.kind !== "root"
      || rootAggregate.state !== "ending"
      || rootAggregate.endWorkflowId !== plan.workflowId
      || rootAggregate.endWorkflowGeneration !== plan.workflowGeneration) conflict();
    const childObserved = authority.get(context.binding.projectId, plan.plannedAction.childSessionId);
    if (childObserved === null) throw new LifecycleError("SESSION_NOT_FOUND");
    const child = Object.freeze({ ...childObserved });
    if (child.parentSessionId !== root.sessionId) invalid("INTEGRITY_FAILURE");
    const validated = assertPlanMatchesChild(authority, plan.plannedAction, child);
    const existing = transfers.get(root.projectId, child.sessionId);
    if (existing !== null) conflict();
    assertHistoryCapacity(authority, transfers, root);
    const eventPosition = authority.nextGlobalPosition();
    if (eventPosition > SQLITE_INT64_MAX - (plan.plannedAction.expectedChildState === "suspended" ? 0n : 1n)) {
      invalid("INTEGRITY_FAILURE");
    }
    const suspensionPosition = plan.plannedAction.expectedChildState === "suspended"
      ? BigInt(plan.plannedAction.expectedSuspensionEventPosition!)
      : eventPosition;
    const transferPosition = plan.plannedAction.expectedChildState === "suspended"
      ? eventPosition
      : eventPosition + 1n;
    const transferTicketId = sessionEndAutomaticTransferTicketId(
      root.projectId as ProjectId,
      plan.workflowId,
      plan.workflowGeneration,
      child.sessionId as SessionId,
    );
    const next = transferredAuthority(child, transferPosition, now.timestamp);
    const suspensionCheckpointId = validated.aggregate.suspensionCheckpointId
      ?? validated.checkpoint.checkpointId;
    const blockers = validated.suspension === null
      ? summaryList(validated.checkpoint.blockers)
      : validated.suspension.payload.blockers;
    const followUps = validated.suspension === null
      ? summaryList(validated.checkpoint.nextActions)
      : validated.suspension.payload.followUps;
    const lineage: SessionEndCarryForwardTicketLineageV1 = Object.freeze({
      lineageKind: "session-end-carry-forward-v1",
      workflowId: plan.workflowId,
      workflowGeneration: plan.workflowGeneration,
      plannedWorkId: plan.plannedWorkId,
      previousParentSessionId: root.sessionId as SessionId,
      previousChildSessionId: child.sessionId as SessionId,
      correlationId: validated.aggregate.correlationId,
      suspensionEventPosition: suspensionPosition.toString(),
      checkpointEventPosition: validated.checkpoint.checkpointEventPosition,
      transferEventPosition: transferPosition.toString(),
    });
    const sourceState = jsonSnapshot(validated.checkpoint.sourceState);
    const ticket: ChildTransferTicketInsert = Object.freeze({
      projectId: child.projectId,
      transferTicketId,
      sourceParentSessionId: root.sessionId,
      sourceChildSessionId: child.sessionId,
      sourceAssignment: Object.freeze({
        assignmentId: validated.aggregate.assignment.assignmentId,
        summary: validated.aggregate.assignment.summary,
        scope: validated.aggregate.assignment.scope,
        assignmentRevision: validated.aggregate.assignmentRevision,
      }),
      sourceScope: Object.freeze({ scope: validated.aggregate.assignment.scope }),
      checkpointId: validated.checkpoint.checkpointId,
      blockers,
      followUps,
      sourceState,
      lineage: lineage as unknown as LifecycleJsonValue,
      createdEventPosition: transferPosition,
      createdAtMs: now.milliseconds,
    });
    const result: CarryForwardChildResultV1 = Object.freeze({
      resultVersion: 1,
      action: "carry-forward-child",
      workflowId: plan.workflowId,
      workflowGeneration: plan.workflowGeneration,
      plannedWorkId: plan.plannedWorkId,
      rootSessionId: root.sessionId as SessionId,
      childSessionId: child.sessionId as SessionId,
      previousChildState: plan.plannedAction.expectedChildState,
      childState: "transferred",
      transferTicketId,
      suspensionEventPosition: suspensionPosition.toString(),
      transferTicketEventPosition: transferPosition.toString(),
      finalChildStreamVersion: (
        validated.aggregate.streamVersion
        + (plan.plannedAction.expectedChildState === "suspended" ? 1n : 2n)
      ).toString(),
    });
    const suspensionCommitment = plan.plannedAction.expectedChildState === "suspended"
      ? null
      : authorityCommitment(committedAuthority({
          ...child,
          semanticState: "suspended",
          authorityEventPosition: suspensionPosition,
          revocationReasonCode: "child-suspended",
          revocationEventPosition: suspensionPosition,
          revokedAt: now.timestamp,
          updatedAt: now.timestamp,
        }));
    const events: PendingEvent[] = [];
    if (suspensionCommitment !== null) {
      events.push(pendingEvent("ChildSessionSuspended", 1, child.sessionId, root.sessionId, now.timestamp, {
        checkpointId: validated.checkpoint.checkpointId,
        blockers: [...blockers],
        followUps: [...followUps],
        authorityCommitment: suspensionCommitment,
      }, latestEventId(validated.events)));
    }
    events.push(pendingEvent("ChildWorkTransferCreated", 2, child.sessionId, root.sessionId, now.timestamp, {
      transferTicketId,
      suspensionCheckpointId,
      checkpointId: validated.checkpoint.checkpointId,
      authorityCommitment: next.authorityCommitment,
    }, suspensionCommitment === null ? latestEventId(validated.events) : PREVIOUS_PENDING_EVENT_CAUSATION));
    return {
      append: {
        context,
        commandId: plan.commandId,
        idempotencyKey: plan.idempotencyKey,
        commandType: plan.commandType,
        correlationId: validated.aggregate.correlationId,
        agentId: plan.agentId,
        expectedStreamVersion: validated.aggregate.streamVersion,
        streamId: child.streamId,
        streamType: "session",
        events,
        outbox: [],
        publicResponse: result,
      },
      authorizationRecord,
      beforeAppend: (_planned, currentTransaction) => {
        if (!authorityOperations(currentTransaction).compareAndSwap({
          projectId: child.projectId,
          sessionId: child.sessionId,
          expectedState: child.semanticState as ChildSessionState,
          expectedOwnerGeneration: null,
          expectedChildCapabilityGeneration: child.childCapabilityGeneration,
          expectedAuthorityCommitment: child.authorityCommitment,
          next: authorityMutation(next),
        })) conflict();
      },
      afterAppend: (committed, currentTransaction) => {
        if (committed.events.length !== events.length
          || committed.events.at(-1)?.globalPosition !== transferPosition) invalid("INTEGRITY_FAILURE");
        const currentTransfers = transferOperations(currentTransaction);
        currentTransfers.insert(ticket);
      },
    };
  }
}
