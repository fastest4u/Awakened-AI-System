import { createHash } from "node:crypto";
import { assertFreshStartHousekeepingAllowed } from "../fresh-start/fresh-start-admission.js";
import type {
  JsonValue,
  LifecycleReplayExpectation,
  PendingEvent,
  PersistedLifecycleAuthorizationRecord,
} from "../contracts/event.js";
import type { ProjectContext } from "../identity/contracts.js";
import type {
  RootAuthorityInsert,
  RootLeaseInsert,
  SafeResumeCandidateQuery,
  SessionAuthorityMutation,
  SessionAuthorityRecord,
} from "../storage/lifecycle-storage.types.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import {
  authorityCommitment,
  type CommittedAuthorityV1,
} from "./authority/authority-commitment.js";
import type {
  WorkerAuthorityMaterialResultV1,
  WorkerLifecycleResult,
} from "./authority/authority-material-adapter.js";
import type {
  PreparedLifecycleWorkerCommand,
  RedactedLifecycleApproval,
  BoundedLifecycleOperation,
  RootRecoveryCommandV2,
  RootResumeCommandV2,
  RootStartCommandV2,
  RootSuspendCommandV2,
  RootSuspendCommandV3,
  RequestSessionEndCommandV2,
  RequestSessionEndCommandV3,
  AmendSessionEndCommandV2,
  AmendSessionEndCommandV3,
  CancelSessionEndCommandV2,
  AbandonSessionCommandV2,
} from "./contracts/commands.js";
import {
  assertSemanticCommandAuthorization,
  decodeLifecycleSemanticCommandDraft,
} from "./contracts/commands.js";
import type { RootSessionState, SessionId } from "./contracts/identifiers.js";
import {
  decodeCheckpointV1,
  type Checkpoint,
  type SourceStateFingerprintV1,
} from "./contracts/checkpoint.js";
import {
  encodeSessionAmbiguitySummaries,
  LifecycleError,
  MAX_SESSION_AMBIGUITY_SUMMARIES,
} from "./errors.js";
import type { LifecycleFaultInjector } from "./lifecycle-faults.js";
import {
  CapabilityService,
  MAX_BOUNDED_PROOF_HORIZON_MS,
  type StoredCapabilityMaterialV1,
} from "./capability.service.js";
import {
  LifecycleCommandStore,
  type LifecycleCommandTransaction,
} from "./lifecycle-command.store.js";
import { buildLifecycleIntentWitness } from "./lifecycle-intent-witness.js";
import {
  capabilityProofDigest,
  type BoundedOperationProofTargetV1,
  type SemanticCommandProofTargetV1,
} from "./authority/capability-codec.js";
import type { SessionAggregateState } from "./session-aggregate.js";
import type {
  PersistedQualityPolicyInputV1,
  SessionEndRequest,
  SessionEndStatusV2,
  FinalEndingScopeBindingV1,
} from "./contracts/session-end.js";
import {
  deriveEffectiveQualityPolicyV1,
  type EffectiveQualityPolicyInputV1,
} from "./session-end-policy.js";
import {
  createSessionEndEffectiveStateV1,
  foldSessionEndAmendmentV1,
  initialSessionEndEvidenceWindowStateV1,
} from "./session-end-effective-state.js";
import {
  MAX_ROOT_CHILD_HISTORY_V1,
  sessionEndWorkflowId,
} from "./session-end-identifiers.js";
import {
  SessionEndWorkflowService,
  sessionEndGenerationStatusV2,
  requestedSessionEndStatusV2,
} from "./session-end-workflow.service.js";
import type { LifecycleApprovalRepository } from "../storage/lifecycle-approval.repository.js";
import type { SessionAuthorityRepository } from "../storage/session-authority.repository.js";
import type { SessionLeaseRepository } from "../storage/session-lease.repository.js";
import type {
  CarryForwardEndingScopeProjectionRecord,
} from "../storage/lifecycle-storage.types.js";
import {
  CHECKPOINT_MAX_CANONICAL_BYTES,
} from "./contracts/checkpoint.js";
import {
  FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES,
} from "./contracts/session-end.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { isPrimarySqliteBusy } from "../storage/event-append-transaction.js";
import { MAX_CANONICAL_TIMESTAMP_MS } from "../runtime/clock.js";
import {
  CheckpointService,
  requireRiskyTransitionCheckpointV1,
} from "./checkpoint.service.js";
import type {
  SourceStateProvider,
  SourceStateScopeResolver,
} from "./source-state.provider.js";
import type {
  LifecycleMaterializationQueuePort,
  PreparedMaterializationQueueV1,
} from "./materialization-queue.port.js";

const OWNER_LEASE_DURATION_MS = 120_000n;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const LOWER_HASH = /^[0-9a-f]{64}$/;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type RootSessionPublicResultV2 = {
  readonly resultVersion: 2;
  readonly project: {
    readonly projectId: string;
    readonly vaultId: string;
    readonly storeId: string;
    readonly workspaceId: string;
    readonly clientNamespace: string;
  };
  readonly sessionId: string;
  readonly ownerGeneration: string;
  readonly continuityKey: string;
  readonly state: RootSessionState;
  readonly resumedFromSessionId: string | null;
  readonly latestCheckpointEventPosition: string | null;
  readonly eventPosition: string;
  readonly handleIssued: boolean;
  readonly resumeTokenIssued: boolean;
  readonly contextPackUnavailable: true;
};

export interface LifecycleProcessorClock {
  nowMs(): bigint;
}

export interface RootLeaseRenewalResultV1 {
  readonly resultVersion: 1;
  readonly operationId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly ownerGeneration: string;
  readonly lastObservedAt: string;
  readonly expiresAt: string;
}

export interface LifecycleProcessorIdentitySource {
  uuid(): string;
}

export interface LifecycleProcessorIntegrity {
  assertQuickHealthy(context: ProjectContext): void;
}

export interface LifecycleSessionEndPolicyResolver {
  resolve(
    context: ProjectContext,
    request: SessionEndRequest,
  ): EffectiveQualityPolicyInputV1;
}

export interface LifecycleResumeSourceStatePort {
  captureCurrent(context: ProjectContext): SourceStateFingerprintV1;
}

export interface LifecycleCommandProcessorOptions {
  readonly connection: SqliteConnection;
  readonly commandStore: LifecycleCommandStore;
  readonly authorityRepository: SessionAuthorityRepository;
  readonly leaseRepository: SessionLeaseRepository;
  readonly approvalRepository: LifecycleApprovalRepository;
  readonly capabilityService: CapabilityService;
  readonly clock: LifecycleProcessorClock;
  readonly identitySource: LifecycleProcessorIdentitySource;
  readonly integrity: LifecycleProcessorIntegrity;
  readonly resumeSourceState: LifecycleResumeSourceStatePort;
  readonly checkpointSourceStateProvider: SourceStateProvider;
  readonly checkpointSourceStateScopeResolver: SourceStateScopeResolver;
  readonly sessionEndPolicy?: LifecycleSessionEndPolicyResolver;
  readonly materializationQueue?: LifecycleMaterializationQueuePort;
  readonly faultInjector?: LifecycleFaultInjector;
}

interface RootAuthorityOperations {
  get(projectId: string, sessionId: string): SessionAuthorityRecord | null;
  insertRoot(input: RootAuthorityInsert): void;
  listSafeResumeCandidates(input: SafeResumeCandidateQuery): readonly SessionAuthorityRecord[];
  listNonterminalRootContinuityOwners(input: {
    readonly projectId: string;
    readonly workspaceId: string;
    readonly clientNamespace: string;
    readonly continuityFingerprint: string;
  }): readonly SessionAuthorityRecord[];
  listNonterminalChildren(
    projectId: string,
    rootSessionId: string,
  ): readonly SessionAuthorityRecord[];
  rootContinuityKey(authority: SessionAuthorityRecord): string;
  latestCheckpoint(authority: SessionAuthorityRecord): Checkpoint | null;
  nextGlobalPosition(): bigint;
  requireFoldMatch(input: SessionAuthorityRecord): SessionAggregateState;
  compareAndSwap(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly expectedState: RootSessionState;
    readonly expectedOwnerGeneration: bigint;
    readonly expectedChildCapabilityGeneration: null;
    readonly expectedAuthorityCommitment: string;
    readonly next: SessionAuthorityMutation;
  }): boolean;
}

interface RootLeaseOperations {
  current(projectId: string, sessionId: string): import("../storage/lifecycle-storage.types.js").RootLeaseRecord | null;
  isExpired(
    lease: import("../storage/lifecycle-storage.types.js").RootLeaseRecord,
    observedNowMs: bigint,
  ): boolean;
  insertGeneration(input: RootLeaseInsert): unknown;
  renewCurrent(input: import("../storage/lifecycle-storage.types.js").RootLeaseRenewal): unknown;
  releaseCurrent(input: import("../storage/lifecycle-storage.types.js").RootLeaseRelease): void;
}

interface RecoveryApprovalOperations {
  consume(input: import("../storage/lifecycle-storage.types.js").ApprovalConsumptionInput): void;
}

function invalid(code: "LIFECYCLE_INPUT_INVALID" | "INTEGRITY_FAILURE" = "LIFECYCLE_INPUT_INVALID"): never {
  throw new LifecycleError(code);
}

function compareBinaryText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactNow(clock: LifecycleProcessorClock): { readonly milliseconds: bigint; readonly timestamp: string } {
  const milliseconds = clock.nowMs();
  if (typeof milliseconds !== "bigint" || milliseconds < 0n || milliseconds > 253_402_300_799_999n) {
    invalid();
  }
  return Object.freeze({
    milliseconds,
    timestamp: new Date(Number(milliseconds)).toISOString(),
  });
}

type RenewRootLeaseOperationV1 = Extract<
  BoundedLifecycleOperation,
  { readonly operation: "renew-root-lease" }
>;

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) invalid();
  const output: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function canonicalSourceStateFingerprint(value: unknown): string {
  const state = exactDataRecord(value, [
    "sourceStateScopeVersion",
    "workspaceId",
    "branchRef",
    "headCommit",
    "dirtyWorktreeFingerprint",
  ]);
  if (
    state.sourceStateScopeVersion !== 1
    || typeof state.workspaceId !== "string"
    || !LOWER_HASH.test(state.workspaceId)
    || (
      state.branchRef !== null
      && (
        typeof state.branchRef !== "string"
        || Array.from(state.branchRef).length < 1
        || Array.from(state.branchRef).length > 1_024
      )
    )
    || (
      state.headCommit !== null
      && (
        typeof state.headCommit !== "string"
        || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(state.headCommit)
      )
    )
    || typeof state.dirtyWorktreeFingerprint !== "string"
    || !LOWER_HASH.test(state.dirtyWorktreeFingerprint)
  ) invalid("INTEGRITY_FAILURE");
  return canonicalJson(state);
}

function canonicalTimestampMilliseconds(value: unknown): bigint {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalid();
  const milliseconds = BigInt(parsed);
  if (milliseconds < 0n || milliseconds > MAX_CANONICAL_TIMESTAMP_MS) invalid();
  return milliseconds;
}

function sameProjectContext(context: ProjectContext, supplied: unknown): void {
  if (
    context?.binding === undefined
    || context.binding.actorRole !== "primary"
    || context.workspace !== context.binding.workspace
    || context.binding.clientNamespace.length === 0
    || context.binding.clientInstanceId.length === 0
  ) throw new LifecycleError("PROJECT_BINDING_REQUIRED");
  canonicalTimestampMilliseconds(context.checkedAt);
  try {
    if (canonicalJson(context) !== canonicalJson(supplied)) invalid();
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    invalid();
  }
}

function rootLeaseRenewalOperationHash(input: {
  readonly operationId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly expectedOwnerGeneration: bigint;
}): string {
  return createHash("sha256")
    .update("project-memory/bounded-operation/v1\n", "utf8")
    .update(canonicalJson({
      operationType: "renew-root-lease",
      operationId: input.operationId,
      requestId: input.requestId,
      sessionId: input.sessionId,
      expectedOwnerGeneration: input.expectedOwnerGeneration.toString(),
    }), "utf8")
    .digest("hex");
}

function rootLeaseRenewalTarget(
  context: ProjectContext,
  operationInput: RenewRootLeaseOperationV1,
): {
  readonly operation: RenewRootLeaseOperationV1;
  readonly generation: bigint;
  readonly target: BoundedOperationProofTargetV1;
} {
  const operation = exactDataRecord(operationInput, [
    "context",
    "operation",
    "operationId",
    "requestId",
    "sessionId",
    "expectedOwnerGeneration",
    "authorization",
  ]);
  if (
    operation.operation !== "renew-root-lease"
    || typeof operation.operationId !== "string"
    || !LOWER_UUID.test(operation.operationId)
    || typeof operation.requestId !== "string"
    || !LOWER_UUID.test(operation.requestId)
    || typeof operation.sessionId !== "string"
    || !LOWER_UUID.test(operation.sessionId)
    || typeof operation.expectedOwnerGeneration !== "number"
    || !Number.isSafeInteger(operation.expectedOwnerGeneration)
    || operation.expectedOwnerGeneration < 1
  ) invalid();
  sameProjectContext(context, operation.context);
  const authorization = exactDataRecord(operation.authorization, [
    "kind",
    "authoritySessionId",
    "targetSessionId",
    "proof",
    "audience",
  ]);
  const audience = exactDataRecord(authorization.audience, [
    "presentingActorRole",
    "presentingClientInstanceId",
    "targetActorRole",
    "targetClientInstanceId",
  ]);
  if (
    authorization.kind !== "bounded-operation"
    || authorization.authoritySessionId !== operation.sessionId
    || authorization.targetSessionId !== operation.sessionId
    || audience.presentingActorRole !== "primary"
    || audience.presentingClientInstanceId !== context.binding.clientInstanceId
    || audience.targetActorRole !== "primary"
    || audience.targetClientInstanceId !== context.binding.clientInstanceId
  ) invalid();
  const proof = exactDataRecord(authorization.proof, [
    "proofVersion",
    "target",
    "proofNonce",
    "proofFingerprint",
  ]);
  if (
    proof.proofVersion !== 1
    || proof.target !== "bounded-operation"
    || typeof proof.proofNonce !== "string"
    || !LOWER_UUID.test(proof.proofNonce)
    || typeof proof.proofFingerprint !== "string"
    || !LOWER_HASH.test(proof.proofFingerprint)
  ) invalid();
  const generation = BigInt(operation.expectedOwnerGeneration);
  if (generation > SQLITE_INT64_MAX) invalid();
  const checkedAtMs = canonicalTimestampMilliseconds(context.checkedAt);
  const expiresAtMs = checkedAtMs + MAX_BOUNDED_PROOF_HORIZON_MS;
  if (expiresAtMs > MAX_CANONICAL_TIMESTAMP_MS) invalid();
  const typed = operationInput;
  return Object.freeze({
    operation: typed,
    generation,
    target: Object.freeze({
      proofVersion: 1,
      target: "bounded-operation",
      operationType: "renew-root-lease",
      operationId: operation.operationId,
      requestId: operation.requestId,
      operationHash: rootLeaseRenewalOperationHash({
        operationId: operation.operationId,
        requestId: operation.requestId,
        sessionId: operation.sessionId,
        expectedOwnerGeneration: generation,
      }),
      authoritySessionId: operation.sessionId,
      targetSessionId: operation.sessionId,
      presentingActorRole: "primary",
      presentingClientInstanceId: context.binding.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: context.binding.clientInstanceId,
      capabilityGeneration: generation.toString(),
      proofNonce: proof.proofNonce,
      expiresAt: new Date(Number(expiresAtMs)).toISOString(),
    }),
  });
}

function ownMethod<T extends (...arguments_: never[]) => unknown>(
  value: object,
  name: string,
): T {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (
    descriptor === undefined
    || !descriptor.enumerable
    || !("value" in descriptor)
    || typeof descriptor.value !== "function"
  ) invalid("INTEGRITY_FAILURE");
  return descriptor.value as T;
}

function rootOperations(transaction: LifecycleCommandTransaction): RootAuthorityOperations {
  const value = transaction.authority as object;
  return Object.freeze({
    get: ownMethod<RootAuthorityOperations["get"]>(value, "get"),
    insertRoot: ownMethod<RootAuthorityOperations["insertRoot"]>(value, "insertRoot"),
    listSafeResumeCandidates: ownMethod<RootAuthorityOperations["listSafeResumeCandidates"]>(
      value,
      "listSafeResumeCandidates",
    ),
    listNonterminalRootContinuityOwners: ownMethod<
      RootAuthorityOperations["listNonterminalRootContinuityOwners"]
    >(value, "listNonterminalRootContinuityOwners"),
    listNonterminalChildren: ownMethod<RootAuthorityOperations["listNonterminalChildren"]>(
      value,
      "listNonterminalChildren",
    ),
    rootContinuityKey: ownMethod<RootAuthorityOperations["rootContinuityKey"]>(
      value,
      "rootContinuityKey",
    ),
    latestCheckpoint: ownMethod<RootAuthorityOperations["latestCheckpoint"]>(
      value,
      "latestCheckpoint",
    ),
    nextGlobalPosition: ownMethod<RootAuthorityOperations["nextGlobalPosition"]>(
      value,
      "nextGlobalPosition",
    ),
    requireFoldMatch: ownMethod<RootAuthorityOperations["requireFoldMatch"]>(
      value,
      "requireFoldMatch",
    ),
    compareAndSwap: ownMethod<RootAuthorityOperations["compareAndSwap"]>(
      value,
      "compareAndSwap",
    ),
  });
}

function optionalOwnMethod<T extends (...arguments_: never[]) => unknown>(
  value: object,
  name: string,
): T | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "function") {
    invalid("INTEGRITY_FAILURE");
  }
  return descriptor.value as T;
}

function currentChildEndingScopeBinding(
  child: SessionAuthorityRecord,
  aggregate: SessionAggregateState,
): FinalEndingScopeBindingV1 {
  if (
    child.sessionKind !== "child"
    || aggregate.kind !== "child"
    || (aggregate.state !== "active"
      && aggregate.state !== "completion-proposed"
      && aggregate.state !== "suspended")
    || child.terminalEventPosition !== null
  ) invalid("INTEGRITY_FAILURE");
  return Object.freeze({
    bindingVersion: 1,
    bindingKind: "current-child",
    childSessionId: child.sessionId as SessionId,
    childState: aggregate.state,
    lastEventPosition: aggregate.eventPosition.toString(),
    streamVersion: aggregate.streamVersion.toString(),
    checkpointId: aggregate.latestCheckpointId,
    checkpointEventPosition: aggregate.latestCheckpointEventPosition?.toString() ?? null,
    transferTicketId: null,
    transferTicketEventPosition: null,
  });
}

function carryForwardEndingScopeBinding(
  projection: CarryForwardEndingScopeProjectionRecord,
): FinalEndingScopeBindingV1 {
  if (
    projection.childState !== "transferred"
    || projection.lastEventPosition <= 0n
    || projection.streamVersion <= 0n
    || projection.checkpointEventPosition <= 0n
    || projection.transferTicketEventPosition <= 0n
  ) invalid("INTEGRITY_FAILURE");
  return Object.freeze({
    bindingVersion: 1,
    bindingKind: "carry-forward-ticket",
    childSessionId: projection.childSessionId as SessionId,
    childState: "transferred",
    lastEventPosition: projection.lastEventPosition.toString(),
    streamVersion: projection.streamVersion.toString(),
    checkpointId: projection.checkpointId as FinalEndingScopeBindingV1["checkpointId"],
    checkpointEventPosition: projection.checkpointEventPosition.toString(),
    transferTicketId: projection.transferTicketId as FinalEndingScopeBindingV1["transferTicketId"],
    transferTicketEventPosition: projection.transferTicketEventPosition.toString(),
  });
}

function sortEndingScopeBindings(
  bindings: readonly FinalEndingScopeBindingV1[],
): readonly FinalEndingScopeBindingV1[] {
  const sorted = [...bindings].sort((left, right) => Buffer.compare(
    Buffer.from(left.childSessionId, "utf8"),
    Buffer.from(right.childSessionId, "utf8"),
  ));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]?.childSessionId === sorted[index]?.childSessionId) {
      invalid("INTEGRITY_FAILURE");
    }
  }
  return Object.freeze(sorted);
}

function requestEndingScopeBindings(
  transaction: LifecycleCommandTransaction,
  root: SessionAuthorityRecord,
  children: readonly { readonly authority: SessionAuthorityRecord; readonly aggregate: SessionAggregateState }[],
): readonly FinalEndingScopeBindingV1[] {
  const currentBindings = children.map(({ authority, aggregate }) =>
    currentChildEndingScopeBinding(authority, aggregate));
  const listTickets = optionalOwnMethod<(
    projectId: string,
    sourceRootSessionId: string,
    limit: number,
  ) => readonly CarryForwardEndingScopeProjectionRecord[]>(
    transaction.transfers as object,
    "listUnclaimedEndingScopeProjectionsBySourceRoot",
  );
  const tickets = listTickets === undefined
    ? Object.freeze([]) as readonly CarryForwardEndingScopeProjectionRecord[]
    : listTickets(root.projectId, root.sessionId, MAX_ROOT_CHILD_HISTORY_V1);
  if (!Array.isArray(tickets) || tickets.length > MAX_ROOT_CHILD_HISTORY_V1) {
    invalid("INTEGRITY_FAILURE");
  }
  if (tickets.length > MAX_ROOT_CHILD_HISTORY_V1) {
    throw new LifecycleError("CHECKPOINT_CAPACITY_EXCEEDED");
  }
  return sortEndingScopeBindings([
    ...currentBindings,
    ...tickets.map(carryForwardEndingScopeBinding),
  ]);
}

function countRowValue(row: Readonly<Record<string, unknown>>, field: string): bigint {
  const value = row[field];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  invalid("INTEGRITY_FAILURE");
}

function assertRootChildHistoryCapacity(
  connection: SqliteConnection,
  root: SessionAuthorityRecord,
  childEndPolicy: "require-completed" | "suspend-and-carry-forward",
): void {
  const childCount = countRowValue(connection.prepare(`
    SELECT COUNT(*) AS count
    FROM session_authority
    WHERE project_id = $projectId
      AND parent_session_id = $rootSessionId
      AND session_kind = 'child'
  `).get({
    $projectId: root.projectId,
    $rootSessionId: root.sessionId,
  }) ?? {}, "count");
  const ticketCount = countRowValue(connection.prepare(`
    SELECT COUNT(*) AS count
    FROM child_transfer_tickets
    WHERE project_id = $projectId
      AND source_parent_session_id = $rootSessionId
  `).get({
    $projectId: root.projectId,
    $rootSessionId: root.sessionId,
  }) ?? {}, "count");
  if (childCount > BigInt(MAX_ROOT_CHILD_HISTORY_V1)
    || ticketCount > BigInt(MAX_ROOT_CHILD_HISTORY_V1)) {
    throw new LifecycleError("CHECKPOINT_CAPACITY_EXCEEDED");
  }
  if (childEndPolicy === "suspend-and-carry-forward") {
    const eligibleWithoutTicket = countRowValue(connection.prepare(`
      SELECT COUNT(*) AS count
      FROM session_authority AS child
      WHERE child.project_id = $projectId
        AND child.parent_session_id = $rootSessionId
        AND child.session_kind = 'child'
        AND child.terminal_event_position IS NULL
        AND child.semantic_state IN ('active', 'completion-proposed', 'suspended')
        AND NOT EXISTS (
          SELECT 1
          FROM child_transfer_tickets AS ticket
          WHERE ticket.project_id = child.project_id
            AND ticket.source_parent_session_id = child.parent_session_id
            AND ticket.source_child_session_id = child.session_id
        )
    `).get({
      $projectId: root.projectId,
      $rootSessionId: root.sessionId,
    }) ?? {}, "count");
    if (ticketCount + eligibleWithoutTicket > BigInt(MAX_ROOT_CHILD_HISTORY_V1)) {
      throw new LifecycleError("CHECKPOINT_CAPACITY_EXCEEDED");
    }
  }
}

function persistedQualityPolicy(
  policy: ReturnType<typeof deriveEffectiveQualityPolicyV1>,
): PersistedQualityPolicyInputV1 {
  return Object.freeze({
    qualityPolicyVersion: 1,
    profiles: policy.profiles,
    qualityThreshold: policy.qualityThreshold,
    requireFullEvidence: policy.requireFullEvidence,
    requireMaterialization: policy.requireMaterialization,
  });
}

function registerAffectedExistingSession(
  transaction: LifecycleCommandTransaction,
  sessionId: SessionId,
): void {
  ownMethod<
    LifecycleCommandTransaction["coverage"]["registerAffectedExistingSessions"]
  >(
    transaction.coverage as object,
    "registerAffectedExistingSessions",
  )([sessionId]);
}

function riskyTransitionChildren(
  authority: RootAuthorityOperations,
  root: SessionAuthorityRecord,
): readonly {
  readonly authority: SessionAuthorityRecord;
  readonly aggregate: SessionAggregateState;
}[] {
  return Object.freeze(authority.listNonterminalChildren(root.projectId, root.sessionId)
    .map((observed) => {
      const child = Object.freeze({ ...observed }) as SessionAuthorityRecord;
      authority.latestCheckpoint(child);
      const aggregate = authority.requireFoldMatch(child);
      if (child.sessionKind !== "child" || child.parentSessionId !== root.sessionId
        || aggregate.kind !== "child" || aggregate.parentSessionId !== root.sessionId) {
        invalid("INTEGRITY_FAILURE");
      }
      return Object.freeze({ authority: child, aggregate });
    }));
}

function leaseOperations(transaction: LifecycleCommandTransaction): RootLeaseOperations {
  const value = transaction.leases as object;
  return Object.freeze({
    current: ownMethod<RootLeaseOperations["current"]>(value, "current"),
    isExpired: ownMethod<RootLeaseOperations["isExpired"]>(value, "isExpired"),
    insertGeneration: ownMethod<RootLeaseOperations["insertGeneration"]>(value, "insertGeneration"),
    renewCurrent: ownMethod<RootLeaseOperations["renewCurrent"]>(value, "renewCurrent"),
    releaseCurrent: ownMethod<RootLeaseOperations["releaseCurrent"]>(value, "releaseCurrent"),
  });
}

function approvalOperations(transaction: LifecycleCommandTransaction): RecoveryApprovalOperations {
  const value = transaction.approvals as object;
  return Object.freeze({
    consume: ownMethod<RecoveryApprovalOperations["consume"]>(value, "consume"),
  });
}

function validateContext(
  context: ProjectContext,
  command:
    | RootStartCommandV2
    | RootResumeCommandV2
    | RootSuspendCommandV2
    | RootSuspendCommandV3
    | RequestSessionEndCommandV2
    | RequestSessionEndCommandV3
    | AmendSessionEndCommandV2
    | AmendSessionEndCommandV3
    | CancelSessionEndCommandV2
    | AbandonSessionCommandV2,
): void {
  const binding = context?.binding;
  if (
    binding === undefined
    || binding.actorRole !== "primary"
    || binding.projectId !== command.expectedProjectId
    || binding.vaultId !== command.expectedVaultId
    || binding.workspaceId !== command.expectedWorkspaceId
    || context.workspace.workspaceId !== binding.workspaceId
    || context.workspace !== binding.workspace
    || binding.clientNamespace.length === 0
    || binding.clientInstanceId.length === 0
  ) throw new LifecycleError("PROJECT_BINDING_REQUIRED");
  const branchRef = context.workspace.kind === "git" ? context.workspace.branchRef : null;
  if (command.expectedBranchRef !== branchRef) throw new LifecycleError("WORKSPACE_AMBIGUOUS");
}

function validateRecoveryContext(
  context: ProjectContext,
  command: RootRecoveryCommandV2,
): void {
  const binding = context?.binding;
  if (
    binding === undefined
    || (binding.actorRole !== "primary" && binding.actorRole !== "maintenance")
    || binding.projectId !== command.expectedProjectId
    || binding.vaultId !== command.expectedVaultId
    || binding.workspaceId !== command.expectedWorkspaceId
    || context.workspace.workspaceId !== binding.workspaceId
    || context.workspace !== binding.workspace
    || binding.clientNamespace.length === 0
    || binding.clientInstanceId.length === 0
  ) throw new LifecycleError("PROJECT_BINDING_REQUIRED");
  const branchRef = context.workspace.kind === "git" ? context.workspace.branchRef : null;
  if (command.expectedBranchRef !== branchRef) throw new LifecycleError("WORKSPACE_AMBIGUOUS");
}

function authorityMutation(record: SessionAuthorityRecord): SessionAuthorityMutation {
  return {
    semanticState: record.semanticState,
    ownerGeneration: record.ownerGeneration,
    childCapabilityGeneration: record.childCapabilityGeneration,
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
    rootHandleIssuanceId: record.rootHandleIssuanceId,
    resumeTokenCapabilityVersion: record.resumeTokenCapabilityVersion,
    resumeTokenKeyId: record.resumeTokenKeyId,
    resumeTokenIssueNonce: record.resumeTokenIssueNonce,
    resumeTokenIssuedAt: record.resumeTokenIssuedAt,
    resumeTokenPolicyCode: record.resumeTokenPolicyCode,
    resumeTokenExpiryKind: record.resumeTokenExpiryKind,
    resumeTokenExpiresAt: record.resumeTokenExpiresAt,
    resumeTokenActorRole: record.resumeTokenActorRole,
    resumeTokenVerifier: record.resumeTokenVerifier,
    resumeTokenIssuanceId: record.resumeTokenIssuanceId,
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
    childHandleIssuanceId: record.childHandleIssuanceId,
    authorityCommitment: record.authorityCommitment,
    authorityEventPosition: record.authorityEventPosition,
    latestCheckpointId: record.latestCheckpointId,
    latestCheckpointEventPosition: record.latestCheckpointEventPosition,
    latestCheckpointFingerprint: record.latestCheckpointFingerprint,
    checkpointRequiredReason: record.checkpointRequiredReason,
    checkpointRequiredEventPosition: record.checkpointRequiredEventPosition,
    revocationReasonCode: record.revocationReasonCode,
    revocationEventPosition: record.revocationEventPosition,
    revokedAt: record.revokedAt,
    terminalEventPosition: record.terminalEventPosition,
    terminalEventType: record.terminalEventType,
    terminalAt: record.terminalAt,
    updatedAt: record.updatedAt,
  };
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

function materialFromAuthority(
  context: ProjectContext,
  authority: SessionAuthorityRecord,
): readonly StoredCapabilityMaterialV1[] {
  if (
    authority.sessionKind !== "root"
    || authority.ownerGeneration === null
    || authority.rootHandleCapabilityVersion !== 1
    || authority.rootHandleKeyId === null
    || authority.rootHandleIssueNonce === null
    || authority.rootHandleIssuedAt === null
    || authority.rootHandlePolicyCode === null
    || authority.rootHandleExpiryKind === null
    || authority.rootHandleActorRole !== "primary"
    || authority.rootHandleClientInstanceId === null
    || authority.rootHandleVerifier === null
    || authority.resumeTokenCapabilityVersion !== 1
    || authority.resumeTokenKeyId === null
    || authority.resumeTokenIssueNonce === null
    || authority.resumeTokenIssuedAt === null
    || authority.resumeTokenPolicyCode === null
    || authority.resumeTokenExpiryKind === null
    || authority.resumeTokenActorRole !== "primary"
    || authority.resumeTokenVerifier === null
  ) invalid("INTEGRITY_FAILURE");
  const common = {
    projectId: authority.projectId,
    vaultId: context.binding.vaultId,
    storeId: context.binding.storeId,
    workspaceId: authority.workspaceId,
    clientNamespace: authority.clientNamespace,
    sessionId: authority.sessionId,
    capabilityGeneration: authority.ownerGeneration.toString(),
  } as const;
  return Object.freeze([
    Object.freeze({
      claims: {
        capabilityVersion: 1 as const,
        keyId: authority.rootHandleKeyId,
        ...common,
        kind: "root-session-handle" as const,
        issuedAt: authority.rootHandleIssuedAt,
        policyCode: authority.rootHandlePolicyCode,
        expiryKind: authority.rootHandleExpiryKind,
        expiresAt: authority.rootHandleExpiresAt,
        issueNonce: authority.rootHandleIssueNonce,
        actorRole: "primary" as const,
        clientInstanceId: authority.rootHandleClientInstanceId,
      },
      verifier: authority.rootHandleVerifier,
    }),
    Object.freeze({
      claims: {
        capabilityVersion: 1 as const,
        keyId: authority.resumeTokenKeyId,
        ...common,
        kind: "root-resume-token" as const,
        issuedAt: authority.resumeTokenIssuedAt,
        policyCode: authority.resumeTokenPolicyCode,
        expiryKind: authority.resumeTokenExpiryKind,
        expiresAt: authority.resumeTokenExpiresAt,
        issueNonce: authority.resumeTokenIssueNonce,
        actorRole: "primary" as const,
        clientInstanceId: null,
      },
      verifier: authority.resumeTokenVerifier,
    }),
  ]);
}

function initialReplayExpectation(
  context: ProjectContext,
): Extract<LifecycleReplayExpectation, { kind: "initial-authority" }> {
  const principal = Object.freeze({
    actorRole: "primary" as const,
    clientInstanceId: context.binding.clientInstanceId,
  });
  return Object.freeze({ kind: "initial-authority" as const, presenting: principal, target: principal });
}

function initialAuthorization(
  context: ProjectContext,
  sessionId: string,
): PersistedLifecycleAuthorizationRecord {
  const expectation = initialReplayExpectation(context);
  return Object.freeze({
    ...expectation,
    authorizationSessionId: null,
    targetSessionId: sessionId,
    proof: null,
    approval: null,
  });
}

function recoveryReplayExpectation(
  context: ProjectContext,
  command: RootRecoveryCommandV2,
  approval: RedactedLifecycleApproval,
  candidateIntentHash: string,
): Extract<LifecycleReplayExpectation, { kind: "protected" }> {
  if (
    !LOWER_HASH.test(candidateIntentHash)
    || approval.action !== "recover-root-authority"
    || approval.reasonCode !== command.reasonCode
    || approval.projectId !== context.binding.projectId
    || approval.vaultId !== context.binding.vaultId
    || approval.storeId !== context.binding.storeId
    || approval.workspaceId !== context.binding.workspaceId
    || approval.sessionId !== command.sessionId
    || approval.expectedOwnerGeneration !== command.expectedOwnerGeneration
    || approval.commandId !== command.commandId
    || approval.idempotencyKey !== command.idempotencyKey
    || approval.intentHash !== candidateIntentHash
    || approval.executorActorRole !== context.binding.actorRole
    || approval.executorClientInstanceId !== context.binding.clientInstanceId
    || approval.targetActorRole !== "primary"
    || approval.targetClientInstanceId.length === 0
  ) throw new LifecycleError("LIFECYCLE_APPROVAL_INVALID");
  return Object.freeze({
    kind: "protected",
    proof: null,
    approval: Object.freeze({
      approvalId: approval.approvalId,
      digest: approval.approvalFingerprint,
    }),
    authorizationSessionId: command.sessionId,
    targetSessionId: command.sessionId,
    presenting: Object.freeze({
      actorRole: context.binding.actorRole,
      clientInstanceId: context.binding.clientInstanceId,
    }),
    target: Object.freeze({
      actorRole: "primary",
      clientInstanceId: approval.targetClientInstanceId,
    }),
  });
}

function abandonmentReplayExpectation(
  context: ProjectContext,
  command: AbandonSessionCommandV2,
  approval: RedactedLifecycleApproval,
  proof: { readonly nonce: string; readonly digest: string },
  candidateIntentHash: string,
): Extract<LifecycleReplayExpectation, { kind: "protected" }> {
  if (
    !LOWER_HASH.test(candidateIntentHash)
    || approval.action !== "abandon-root"
    || approval.reasonCode !== command.reasonCode
    || approval.projectId !== context.binding.projectId
    || approval.vaultId !== context.binding.vaultId
    || approval.storeId !== context.binding.storeId
    || approval.workspaceId !== context.binding.workspaceId
    || approval.sessionId !== command.sessionId
    || approval.commandId !== command.commandId
    || approval.idempotencyKey !== command.idempotencyKey
    || approval.intentHash !== candidateIntentHash
    || approval.executorActorRole !== context.binding.actorRole
    || approval.executorClientInstanceId !== context.binding.clientInstanceId
    || approval.targetActorRole !== "primary"
    || approval.targetClientInstanceId.length === 0
  ) throw new LifecycleError("LIFECYCLE_APPROVAL_INVALID");
  return Object.freeze({
    kind: "protected",
    proof: Object.freeze({ version: 1, nonce: proof.nonce, digest: proof.digest }),
    approval: Object.freeze({
      approvalId: approval.approvalId,
      digest: approval.approvalFingerprint,
    }),
    authorizationSessionId: command.sessionId,
    targetSessionId: command.sessionId,
    presenting: Object.freeze({
      actorRole: context.binding.actorRole,
      clientInstanceId: context.binding.clientInstanceId,
    }),
    target: Object.freeze({
      actorRole: "primary",
      clientInstanceId: approval.targetClientInstanceId,
    }),
  });
}

function workerMaterial(
  capabilityService: CapabilityService,
  context: ProjectContext,
  authority: SessionAuthorityRecord,
  expectedGeneration: string,
  target: PersistedLifecycleAuthorizationRecord["target"],
): WorkerAuthorityMaterialResultV1 {
  const resolved = capabilityService.authorityMaterial({
    authorityCommitment: authority.authorityCommitment,
    expectedCapabilityGeneration: expectedGeneration,
    currentCapabilityGeneration: authority.ownerGeneration?.toString() ?? "0",
    target: {
      actorRole: target.actorRole === "primary" ? "primary" : "untrusted",
      clientInstanceId: target.clientInstanceId,
    },
    materials: expectedGeneration === authority.ownerGeneration?.toString()
      ? materialFromAuthority(context, authority)
      : [],
  });
  if (resolved.status === "current" && resolved.descriptor !== undefined) {
    return Object.freeze({
      status: "current",
      target: resolved.descriptor.target,
      authorityCommitment: resolved.descriptor.authorityCommitment,
      capabilityGeneration: resolved.descriptor.capabilityGeneration,
      descriptor: resolved.descriptor,
      recoveryCode: null,
    });
  }
  return Object.freeze({
    status: resolved.status,
    target: null,
    authorityCommitment: null,
    capabilityGeneration: null,
    descriptor: null,
    recoveryCode: resolved.recoveryCode ?? null,
  });
}

export class LifecycleCommandProcessor {
  readonly #connection: SqliteConnection;
  readonly #store: LifecycleCommandStore;
  readonly #authority: SessionAuthorityRepository;
  readonly #leases: SessionLeaseRepository;
  readonly #capabilities: CapabilityService;
  readonly #clock: LifecycleProcessorClock;
  readonly #ids: LifecycleProcessorIdentitySource;
  readonly #integrity: LifecycleProcessorIntegrity;
  readonly #resumeSourceState: LifecycleResumeSourceStatePort;
  readonly #checkpointSourceState: SourceStateProvider;
  readonly #checkpointSourceStateScopes: SourceStateScopeResolver;
  readonly #checkpoints: CheckpointService;
  readonly #sessionEndWorkflows: SessionEndWorkflowService;
  readonly #sessionEndPolicy: LifecycleSessionEndPolicyResolver;
  readonly #materializationQueue: LifecycleMaterializationQueuePort | undefined;

  constructor(options: LifecycleCommandProcessorOptions) {
    this.#connection = options.connection;
    this.#store = options.commandStore;
    this.#authority = options.authorityRepository;
    this.#leases = options.leaseRepository;
    this.#capabilities = options.capabilityService;
    this.#clock = options.clock;
    this.#ids = options.identitySource;
    this.#integrity = options.integrity;
    this.#resumeSourceState = options.resumeSourceState;
    this.#checkpointSourceState = options.checkpointSourceStateProvider;
    this.#checkpointSourceStateScopes = options.checkpointSourceStateScopeResolver;
    this.#sessionEndWorkflows = new SessionEndWorkflowService({
      connection: options.connection,
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
    });
    this.#materializationQueue = options.materializationQueue;
    this.#sessionEndPolicy = options.sessionEndPolicy ?? {
      resolve: (_context, request) => {
        const requestedProfiles = request.validationProfileIds.length === 0
          ? [{ profileId: "default", profileVersion: 1, required: true, weight: 1 }]
          : request.validationProfileIds.map((profileId) => ({
              profileId,
              profileVersion: 1,
              required: true,
              weight: 1,
            }));
        return {
          trustedProfiles: requestedProfiles,
          optionalProfiles: [],
          requestedProfileIds: request.validationProfileIds,
          requestedQualityThreshold: request.requestedQualityThreshold,
          trustedMinimumQualityThreshold: 0,
          trustedRequireFullEvidence: false,
          requestedRequireFullEvidence: request.requireFullEvidence,
          trustedRequireMaterialization: false,
          requestedRequireMaterialization: request.requireMaterialization,
        };
      },
    };
    this.#checkpoints = new CheckpointService({
      invocationScope: {
        current: () => invalid("INTEGRITY_FAILURE"),
      },
      sourceStateProvider: this.#checkpointSourceState,
      identitySource: this.#ids,
      clock: {
        now: () => exactNow(this.#clock).timestamp,
      },
    });
  }

  renewRootLease(
    context: ProjectContext,
    operationInput: RenewRootLeaseOperationV1,
  ): RootLeaseRenewalResultV1 {
    const prepared = rootLeaseRenewalTarget(context, operationInput);
    const operationId = prepared.operation.operationId;
    const requestId = prepared.operation.requestId;
    const sessionId = prepared.operation.sessionId;
    const generation = prepared.generation;
    let transactionBegan = false;
    let commitAttempted = false;
    let commitFailed = false;
    try {
      this.#connection.exec("BEGIN IMMEDIATE");
      transactionBegan = true;
      assertFreshStartHousekeepingAllowed(this.#connection);
      const authority = this.#authority.get(
        this.#connection,
        context.binding.projectId,
        sessionId,
      );
      if (authority === null) throw new LifecycleError("SESSION_NOT_FOUND");
      if (
        authority.sessionKind !== "root"
        || authority.parentSessionId !== null
        || authority.terminalEventPosition !== null
        || (
          authority.semanticState !== "active"
          && authority.semanticState !== "suspended"
          && authority.semanticState !== "ending"
        )
      ) throw new LifecycleError("SESSION_STATE_CONFLICT");
      if (
        authority.ownerGeneration !== generation
        || authority.rootHandleClientInstanceId !== context.binding.clientInstanceId
      ) throw new LifecycleError("SESSION_HANDLE_STALE");
      this.#authority.requireFoldMatch(this.#connection, authority);
      const handle = materialFromAuthority(context, authority).find(
        (candidate) => candidate.claims.kind === "root-session-handle",
      );
      if (handle === undefined) invalid("INTEGRITY_FAILURE");
      this.#capabilities.verifyProof(handle, prepared.target, prepared.operation.authorization.proof);
      const now = exactNow(this.#clock);
      const renewed = this.#leases.renewCurrent(this.#connection, {
        projectId: context.binding.projectId,
        sessionId,
        ownerGeneration: generation,
        ownerClientInstanceId: context.binding.clientInstanceId,
        observedNowMs: now.milliseconds,
        leaseDurationMs: OWNER_LEASE_DURATION_MS,
      });
      commitAttempted = true;
      try {
        this.#connection.exec("COMMIT");
      } catch (error) {
        commitFailed = true;
        throw error;
      }
      transactionBegan = false;
      return Object.freeze({
        resultVersion: 1,
        operationId,
        requestId,
        sessionId,
        ownerGeneration: renewed.ownerGeneration.toString(),
        lastObservedAt: new Date(Number(renewed.lastObservedAtMs)).toISOString(),
        expiresAt: new Date(Number(renewed.expiresAtMs)).toISOString(),
      });
    } catch (error) {
      let rollbackFailed = false;
      if (transactionBegan) {
        try {
          this.#connection.exec("ROLLBACK");
          transactionBegan = false;
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed || (commitAttempted && (!commitFailed || !isPrimarySqliteBusy(error)))) {
        throw new LifecycleError("OPERATION_OUTCOME_UNKNOWN", { operationId });
      }
      throw error;
    }
  }

  startRoot(
    context: ProjectContext,
    input: PreparedLifecycleWorkerCommand<RootStartCommandV2>,
  ): WorkerLifecycleResult<RootSessionPublicResultV2> {
    const decoded = decodeLifecycleSemanticCommandDraft(input.command);
    if (decoded.commandType !== "root-start") invalid();
    assertSemanticCommandAuthorization(decoded, input.authorization);
    validateContext(context, decoded);
    const assertions = {
      authorizationKind: "initial-authority" as const,
      authorizationSessionId: null,
      targetSessionId: decoded.commandId,
      projectId: context.binding.projectId,
      vaultId: context.binding.vaultId,
      storeId: context.binding.storeId,
      workspaceId: context.binding.workspaceId,
      clientNamespace: context.binding.clientNamespace,
      capabilityKind: null,
      capabilityGeneration: null,
      presentingActorRole: "primary" as const,
      presentingClientInstanceId: context.binding.clientInstanceId,
      targetActorRole: "primary" as const,
      targetClientInstanceId: context.binding.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
    };
    const authoritative = buildLifecycleIntentWitness(decoded, assertions);
    if (!LOWER_HASH.test(input.candidateIntentHash) || authoritative.intentHash !== input.candidateIntentHash) {
      throw new LifecycleError("IDEMPOTENCY_CONFLICT");
    }
    const execution = this.#store.execute<RootSessionPublicResultV2>({
      context,
      commandId: decoded.commandId,
      idempotencyKey: decoded.idempotencyKey,
      commandType: decoded.commandType,
      candidateIntentHash: input.candidateIntentHash,
      authoritativeIntentHash: authoritative.intentHash,
      semanticCommand: decoded,
      capabilityKind: null,
      capabilityGeneration: null,
      replayExpectation: initialReplayExpectation(context),
    }, (transaction) => {
      const authority = rootOperations(transaction);
      const now = exactNow(this.#clock);
      const continuity = this.#capabilities.continuityFingerprint({
        projectId: context.binding.projectId,
        storeId: context.binding.storeId,
        clientNamespace: context.binding.clientNamespace,
        continuityKey: decoded.continuityKey,
      });
      const owners = authority.listNonterminalRootContinuityOwners({
        projectId: context.binding.projectId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        continuityFingerprint: continuity.fingerprint,
      });
      if (owners.length !== 0) throw new LifecycleError("CONTINUITY_CONFLICT");
      const sessionId = this.#ids.uuid();
      const correlationId = this.#ids.uuid();
      const handle = this.#capabilities.prepareCapability({
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        sessionId,
        kind: "root-session-handle",
        capabilityGeneration: "1",
        policyCode: "root-default-v1",
        expiryKind: "until-revoked",
        expiresAt: null,
        actorRole: "primary",
        clientInstanceId: context.binding.clientInstanceId,
      });
      const resume = this.#capabilities.prepareCapability({
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        sessionId,
        kind: "root-resume-token",
        capabilityGeneration: "1",
        policyCode: "resume-default-v1",
        expiryKind: "until-revoked",
        expiresAt: null,
        actorRole: "primary",
        clientInstanceId: null,
      });
      const eventPosition = authority.nextGlobalPosition();
      if (eventPosition < 1n || eventPosition > SQLITE_INT64_MAX) invalid("INTEGRITY_FAILURE");
      const provisional: RootAuthorityInsert = {
        projectId: context.binding.projectId,
        sessionId,
        streamId: `session/${sessionId}`,
        sessionKind: "root",
        parentSessionId: null,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        semanticState: "active",
        ownerGeneration: 1n,
        childCapabilityGeneration: null,
        directAccessEnabled: false,
        continuityFingerprintAlgorithm: continuity.algorithm,
        continuityFingerprintSchemaVersion: continuity.schemaVersion,
        continuityFingerprintKeyId: continuity.keyId,
        continuityFingerprintDomain: continuity.domain,
        continuityFingerprint: continuity.fingerprint,
        rootHandleCapabilityVersion: handle.claims.capabilityVersion,
        rootHandleKeyId: handle.claims.keyId,
        rootHandleIssueNonce: handle.claims.issueNonce,
        rootHandleIssuedAt: handle.claims.issuedAt,
        rootHandlePolicyCode: handle.claims.policyCode,
        rootHandleExpiryKind: handle.claims.expiryKind,
        rootHandleExpiresAt: handle.claims.expiresAt,
        rootHandleActorRole: "primary",
        rootHandleClientInstanceId: context.binding.clientInstanceId,
        rootHandleVerifier: handle.verifier,
        rootHandleIssuanceId: this.#ids.uuid(),
        resumeTokenCapabilityVersion: resume.claims.capabilityVersion,
        resumeTokenKeyId: resume.claims.keyId,
        resumeTokenIssueNonce: resume.claims.issueNonce,
        resumeTokenIssuedAt: resume.claims.issuedAt,
        resumeTokenPolicyCode: resume.claims.policyCode,
        resumeTokenExpiryKind: resume.claims.expiryKind,
        resumeTokenExpiresAt: resume.claims.expiresAt,
        resumeTokenActorRole: "primary",
        resumeTokenVerifier: resume.verifier,
        resumeTokenIssuanceId: this.#ids.uuid(),
        childHandleCapabilityVersion: null,
        childHandleKeyId: null,
        childHandleIssueNonce: null,
        childHandleIssuedAt: null,
        childHandlePolicyCode: null,
        childHandleExpiryKind: null,
        childHandleExpiresAt: null,
        childHandleActorRole: null,
        childHandleClientInstanceId: null,
        childHandleVerifier: null,
        childHandleIssuanceId: null,
        authorityCommitment: "0".repeat(64),
        authorityEventPosition: eventPosition,
        latestCheckpointId: null,
        latestCheckpointEventPosition: null,
        latestCheckpointFingerprint: null,
        checkpointRequiredReason: null,
        checkpointRequiredEventPosition: null,
        revocationReasonCode: null,
        revocationEventPosition: null,
        revokedAt: null,
        terminalEventPosition: null,
        terminalEventType: null,
        terminalAt: null,
        createdAt: now.timestamp,
        updatedAt: now.timestamp,
      };
      const commitment = authorityCommitment(committedAuthority(provisional));
      const record = Object.freeze({ ...provisional, authorityCommitment: commitment });
      const publicResult: RootSessionPublicResultV2 = Object.freeze({
        resultVersion: 2,
        project: Object.freeze({
          projectId: context.binding.projectId,
          vaultId: context.binding.vaultId,
          storeId: context.binding.storeId,
          workspaceId: context.binding.workspaceId,
          clientNamespace: context.binding.clientNamespace,
        }),
        sessionId,
        ownerGeneration: "1",
        continuityKey: decoded.continuityKey,
        state: "active",
        resumedFromSessionId: null,
        latestCheckpointEventPosition: null,
        eventPosition: eventPosition.toString(),
        handleIssued: true,
        resumeTokenIssued: true,
        contextPackUnavailable: true,
      });
      return {
        append: {
          context,
          commandId: decoded.commandId,
          idempotencyKey: decoded.idempotencyKey,
          commandType: decoded.commandType,
          correlationId,
          agentId: decoded.agentId,
          expectedStreamVersion: 0n,
          streamId: record.streamId,
          streamType: "session",
          events: [{
            eventType: "SessionStarted",
            eventSchemaVersion: 1,
            occurredAt: now.timestamp,
            visibilityScope: "session",
            sessionId,
            confidence: "high",
            verificationStatus: "verified",
            payload: {
              sessionKind: "root",
              ownerGeneration: 1,
              continuityKey: decoded.continuityKey,
              clientNamespace: context.binding.clientNamespace,
              creatingAgentId: decoded.agentId,
              creatingClientInstanceId: context.binding.clientInstanceId,
              authorityCommitment: commitment,
            },
            sourceRefs: [],
            evidenceRefs: [],
            evidenceDigests: [],
          }] satisfies PendingEvent[],
          outbox: [],
          publicResponse: publicResult,
        },
        authorizationRecord: initialAuthorization(context, sessionId),
        afterAppend: (committed, currentTransaction) => {
          const appended = committed.events[0];
          if (
            committed.events.length !== 1
            || appended === undefined
            || appended.globalPosition !== eventPosition
          ) invalid("INTEGRITY_FAILURE");
          const currentAuthority = rootOperations(currentTransaction);
          const currentLeases = leaseOperations(currentTransaction);
          currentAuthority.insertRoot(record);
          currentLeases.insertGeneration({
            projectId: context.binding.projectId,
            sessionId,
            ownerGeneration: 1n,
            ownerClientInstanceId: context.binding.clientInstanceId,
            observedNowMs: now.milliseconds,
            leaseDurationMs: OWNER_LEASE_DURATION_MS,
          });
        },
      };
    });
    const sessionId = execution.authorizationRecord.targetSessionId;
    const authority = this.#authority.get(this.#connection, context.binding.projectId, sessionId);
    if (authority === null) invalid("INTEGRITY_FAILURE");
    return Object.freeze({
      kind: "success",
      publicResult: execution.publicResult,
      authorityMaterial: workerMaterial(
        this.#capabilities,
        context,
        authority,
        execution.publicResult.ownerGeneration,
        execution.authorizationRecord.target,
      ),
    });
  }

  resumeRoot(
    context: ProjectContext,
    input: PreparedLifecycleWorkerCommand<RootResumeCommandV2>,
  ): WorkerLifecycleResult<RootSessionPublicResultV2> {
    const decoded = decodeLifecycleSemanticCommandDraft(input.command);
    if (decoded.commandType !== "root-resume") invalid();
    assertSemanticCommandAuthorization(decoded, input.authorization);
    validateContext(context, decoded);
    if (
      input.authorization.kind !== "protected"
      || input.authorization.proof === null
      || input.authorization.approval !== null
      || input.authorization.childBindingGrant !== null
      || input.authorization.authoritySessionId !== input.authorization.targetSessionId
    ) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
    const proof = input.authorization.proof;
    const targetSessionId = input.authorization.targetSessionId;
    const assertions = {
      authorizationKind: "protected" as const,
      authorizationSessionId: targetSessionId,
      targetSessionId,
      projectId: context.binding.projectId,
      vaultId: context.binding.vaultId,
      storeId: context.binding.storeId,
      workspaceId: context.binding.workspaceId,
      clientNamespace: context.binding.clientNamespace,
      capabilityKind: "root-resume-token" as const,
      capabilityGeneration: decoded.expectedOwnerGeneration,
      presentingActorRole: "primary" as const,
      presentingClientInstanceId: context.binding.clientInstanceId,
      targetActorRole: "primary" as const,
      targetClientInstanceId: context.binding.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
    };
    const authoritative = buildLifecycleIntentWitness(decoded, assertions);
    if (!LOWER_HASH.test(input.candidateIntentHash) || authoritative.intentHash !== input.candidateIntentHash) {
      throw new LifecycleError("IDEMPOTENCY_CONFLICT");
    }
    const proofBytes = Buffer.from(proof.proofFingerprint, "hex");
    let proofDigest: string;
    try {
      if (proofBytes.length !== 32) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
      proofDigest = capabilityProofDigest(proofBytes);
    } finally {
      proofBytes.fill(0);
    }
    const principal = Object.freeze({
      actorRole: "primary" as const,
      clientInstanceId: context.binding.clientInstanceId,
    });
    const replayExpectation: Extract<LifecycleReplayExpectation, { kind: "protected" }> = Object.freeze({
      kind: "protected",
      proof: Object.freeze({
        version: 1,
        nonce: proof.proofNonce,
        digest: proofDigest,
      }),
      approval: null,
      authorizationSessionId: targetSessionId,
      targetSessionId,
      presenting: principal,
      target: principal,
    });
    const execution = this.#store.execute<RootSessionPublicResultV2>({
      context,
      commandId: decoded.commandId,
      idempotencyKey: decoded.idempotencyKey,
      commandType: decoded.commandType,
      candidateIntentHash: input.candidateIntentHash,
      authoritativeIntentHash: authoritative.intentHash,
      semanticCommand: decoded,
      capabilityKind: "root-resume-token",
      capabilityGeneration: decoded.expectedOwnerGeneration,
      replayExpectation,
    }, (transaction) => {
      const authority = rootOperations(transaction);
      const leases = leaseOperations(transaction);
      const now = exactNow(this.#clock);
      const continuity = decoded.continuityKey === null ? null : this.#capabilities.continuityFingerprint({
        projectId: context.binding.projectId,
        storeId: context.binding.storeId,
        clientNamespace: context.binding.clientNamespace,
        continuityKey: decoded.continuityKey,
      });
      const candidates: SessionAuthorityRecord[] = [];
      const aggregates = new Map<string, Extract<SessionAggregateState, { readonly kind: "root" }>>();
      const pageSize = MAX_SESSION_AMBIGUITY_SUMMARIES + 1;
      const branchRef = context.workspace.kind === "git" ? context.workspace.branchRef : null;
      let afterSessionId: string | null = null;
      let exhausted = false;
      let capturedSourceStateJson: string | null = null;
      while (!exhausted && candidates.length < pageSize) {
        const page: SessionAuthorityRecord[] = [...authority.listSafeResumeCandidates({
          projectId: context.binding.projectId,
          workspaceId: context.binding.workspaceId,
          clientNamespace: context.binding.clientNamespace,
          sessionId: decoded.sessionId,
          continuityFingerprint: continuity?.fingerprint ?? null,
          afterSessionId,
          semanticStates: ["active", "suspended"],
        })].sort((left, right) => compareBinaryText(left.sessionId, right.sessionId));
        if (page.length > pageSize) invalid("INTEGRITY_FAILURE");
        let previousSessionId = afterSessionId;
        for (const candidate of page) {
          if (
            previousSessionId !== null
            && candidate.sessionId <= previousSessionId
          ) invalid("INTEGRITY_FAILURE");
          previousSessionId = candidate.sessionId;
        }
        exhausted = page.length < pageSize;
        if (page.length !== 0) afterSessionId = page.at(-1)!.sessionId;

        let compatible: SessionAuthorityRecord[] = page;
        const pageCheckpoints = new Map<string, Checkpoint>();
        const pageAggregates = new Map<
          string,
          Extract<SessionAggregateState, { readonly kind: "root" }>
        >();
        if (decoded.sessionId !== null) {
          compatible = compatible.filter(
            (candidate) => candidate.sessionId === decoded.sessionId,
          );
        }
        compatible = compatible.filter((candidate) => (
          candidate.projectId === context.binding.projectId
          && candidate.clientNamespace === context.binding.clientNamespace
          && (
            continuity === null
            || candidate.continuityFingerprint === continuity.fingerprint
          )
        ));
        compatible = compatible.filter(
          (candidate) => candidate.workspaceId === context.binding.workspaceId,
        );
        if (decoded.resumePolicy === "latest-safe" && compatible.length !== 0) {
          compatible = compatible.filter((candidate) => {
            const checkpoint = authority.latestCheckpoint(candidate);
            if (checkpoint === null) return true;
            if (
              checkpoint.sourceState.workspaceId !== context.binding.workspaceId
              || checkpoint.sourceState.branchRef !== branchRef
            ) return false;
            pageCheckpoints.set(candidate.sessionId, checkpoint);
            return true;
          });
        }
        compatible = compatible.filter((candidate) => {
          if (
            candidate.sessionKind !== "root"
            || candidate.parentSessionId !== null
            || candidate.terminalEventPosition !== null
            || candidate.ownerGeneration === null
            || (candidate.semanticState !== "active" && candidate.semanticState !== "suspended")
          ) return false;
          const aggregate = authority.requireFoldMatch(candidate);
          if (
            aggregate.kind !== "root"
            || (aggregate.state !== "active" && aggregate.state !== "suspended")
          ) return false;
          pageAggregates.set(candidate.sessionId, aggregate);
          return true;
        });
        if (decoded.resumePolicy === "latest-safe" && compatible.length !== 0) {
          compatible = compatible.filter(
            (candidate) => pageCheckpoints.has(candidate.sessionId),
          );
          if (compatible.length !== 0 && capturedSourceStateJson === null) {
            try {
              capturedSourceStateJson = canonicalSourceStateFingerprint(
                this.#resumeSourceState.captureCurrent(context),
              );
            } catch {
              invalid("INTEGRITY_FAILURE");
            }
          }
          compatible = compatible.filter((candidate) => {
            const checkpoint = pageCheckpoints.get(candidate.sessionId);
            if (checkpoint === undefined || capturedSourceStateJson === null) {
              invalid("INTEGRITY_FAILURE");
            }
            return canonicalJson(checkpoint.sourceState) === capturedSourceStateJson;
          });
        }
        for (const candidate of compatible) {
          if (candidates.length === pageSize) break;
          const aggregate = pageAggregates.get(candidate.sessionId);
          if (aggregate === undefined) invalid("INTEGRITY_FAILURE");
          candidates.push(candidate);
          aggregates.set(candidate.sessionId, aggregate);
        }
      }
      if (candidates.length === 0) throw new LifecycleError("SESSION_NOT_FOUND");
      if (candidates.length !== 1) {
        const visible = candidates.slice(0, MAX_SESSION_AMBIGUITY_SUMMARIES);
        throw new LifecycleError("SESSION_AMBIGUOUS", {
          candidateSummariesJson: encodeSessionAmbiguitySummaries(
            visible.map((candidate) => {
              if (
                candidate.ownerGeneration === null
                || (candidate.semanticState !== "active" && candidate.semanticState !== "suspended")
              ) invalid("INTEGRITY_FAILURE");
              return Object.freeze({
                sessionId: candidate.sessionId,
                state: candidate.semanticState,
                ownerGeneration: candidate.ownerGeneration.toString(),
                latestCheckpointEventPosition:
                  candidate.latestCheckpointEventPosition?.toString() ?? null,
                checkpointRequired: candidate.checkpointRequiredEventPosition !== null,
              });
            }),
            candidates.length > MAX_SESSION_AMBIGUITY_SUMMARIES,
          ),
        });
      }
      const current = Object.freeze({ ...candidates[0]! }) as SessionAuthorityRecord;
      if (current.sessionId !== targetSessionId || current.ownerGeneration === null) {
        throw new LifecycleError("SESSION_OWNERSHIP_MISMATCH");
      }
      registerAffectedExistingSession(transaction, current.sessionId as SessionId);
      const aggregate = aggregates.get(current.sessionId) ?? authority.requireFoldMatch(current);
      if (aggregate.kind !== "root" || (aggregate.state !== "active" && aggregate.state !== "suspended")) {
        throw new LifecycleError("SESSION_STATE_CONFLICT");
      }
      const resumeMaterial = materialFromAuthority(context, current).find(
        (material) => material.claims.kind === "root-resume-token",
      );
      if (resumeMaterial === undefined) invalid("INTEGRITY_FAILURE");
      const proofTarget: SemanticCommandProofTargetV1 = {
        proofVersion: 1,
        target: "semantic-command",
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        authoritySessionId: targetSessionId,
        targetSessionId,
        presentingActorRole: "primary",
        presentingClientInstanceId: context.binding.clientInstanceId,
        targetActorRole: "primary",
        targetClientInstanceId: context.binding.clientInstanceId,
        capabilityKind: "root-resume-token",
        capabilityGeneration: decoded.expectedOwnerGeneration,
        commandId: decoded.commandId,
        idempotencyKey: decoded.idempotencyKey,
        intentHash: authoritative.intentHash,
        proofNonce: proof.proofNonce,
      };
      let verifiedProof: ReturnType<CapabilityService["verifyProof"]>;
      try {
        verifiedProof = this.#capabilities.verifyProof(
          resumeMaterial,
          proofTarget,
          proof,
        );
      } catch (error) {
        if (current.ownerGeneration.toString() !== decoded.expectedOwnerGeneration) {
          throw new LifecycleError("SESSION_HANDLE_STALE");
        }
        throw error;
      }
      if (verifiedProof.digest !== proofDigest) invalid("INTEGRITY_FAILURE");
      if (current.ownerGeneration.toString() !== decoded.expectedOwnerGeneration) {
        throw new LifecycleError("SESSION_HANDLE_STALE");
      }
      const observedLease = leases.current(context.binding.projectId, current.sessionId);
      if (
        observedLease === null
        || observedLease.ownerGeneration !== current.ownerGeneration
        || observedLease.ownerClientInstanceId !== current.rootHandleClientInstanceId
      ) invalid("INTEGRITY_FAILURE");
      const currentLease = Object.freeze({ ...observedLease });
      if (
        currentLease.ownerClientInstanceId !== context.binding.clientInstanceId
        && !leases.isExpired(currentLease, now.milliseconds)
      ) throw new LifecycleError("SESSION_ALREADY_OWNED");
      if (currentLease.ownerClientInstanceId === context.binding.clientInstanceId) {
        throw new LifecycleError("SESSION_ALREADY_OWNED");
      }
      requireRiskyTransitionCheckpointV1({
        authority: current,
        aggregate,
        checkpoint: authority.latestCheckpoint(current),
        relevantChildren: riskyTransitionChildren(authority, current),
      });
      const nextGeneration = current.ownerGeneration + 1n;
      if (nextGeneration > SQLITE_INT64_MAX || nextGeneration > BigInt(Number.MAX_SAFE_INTEGER)) {
        invalid("INTEGRITY_FAILURE");
      }
      const handle = this.#capabilities.prepareCapability({
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        sessionId: current.sessionId,
        kind: "root-session-handle",
        capabilityGeneration: nextGeneration.toString(),
        policyCode: "root-default-v1",
        expiryKind: "until-revoked",
        expiresAt: null,
        actorRole: "primary",
        clientInstanceId: context.binding.clientInstanceId,
      });
      const resume = this.#capabilities.prepareCapability({
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        sessionId: current.sessionId,
        kind: "root-resume-token",
        capabilityGeneration: nextGeneration.toString(),
        policyCode: "resume-default-v1",
        expiryKind: "until-revoked",
        expiresAt: null,
        actorRole: "primary",
        clientInstanceId: null,
      });
      const transferPosition = authority.nextGlobalPosition();
      const eventCount = aggregate.state === "suspended" ? 2n : 1n;
      if (transferPosition > SQLITE_INT64_MAX - eventCount + 1n) invalid("INTEGRITY_FAILURE");
      const nextProvisional: SessionAuthorityRecord = {
        ...current,
        semanticState: "active",
        ownerGeneration: nextGeneration,
        rootHandleCapabilityVersion: handle.claims.capabilityVersion,
        rootHandleKeyId: handle.claims.keyId,
        rootHandleIssueNonce: handle.claims.issueNonce,
        rootHandleIssuedAt: handle.claims.issuedAt,
        rootHandlePolicyCode: handle.claims.policyCode,
        rootHandleExpiryKind: handle.claims.expiryKind,
        rootHandleExpiresAt: handle.claims.expiresAt,
        rootHandleActorRole: "primary",
        rootHandleClientInstanceId: context.binding.clientInstanceId,
        rootHandleVerifier: handle.verifier,
        rootHandleIssuanceId: this.#ids.uuid(),
        resumeTokenCapabilityVersion: resume.claims.capabilityVersion,
        resumeTokenKeyId: resume.claims.keyId,
        resumeTokenIssueNonce: resume.claims.issueNonce,
        resumeTokenIssuedAt: resume.claims.issuedAt,
        resumeTokenPolicyCode: resume.claims.policyCode,
        resumeTokenExpiryKind: resume.claims.expiryKind,
        resumeTokenExpiresAt: resume.claims.expiresAt,
        resumeTokenActorRole: "primary",
        resumeTokenVerifier: resume.verifier,
        resumeTokenIssuanceId: this.#ids.uuid(),
        authorityCommitment: "0".repeat(64),
        authorityEventPosition: transferPosition,
        checkpointRequiredReason: "ownership-transfer",
        checkpointRequiredEventPosition: transferPosition,
        updatedAt: now.timestamp,
      };
      const nextCommitment = authorityCommitment(committedAuthority(nextProvisional));
      const next = Object.freeze({ ...nextProvisional, authorityCommitment: nextCommitment });
      const finalPosition = transferPosition + eventCount - 1n;
      const publicResult: RootSessionPublicResultV2 = Object.freeze({
        resultVersion: 2,
        project: Object.freeze({
          projectId: context.binding.projectId,
          vaultId: context.binding.vaultId,
          storeId: context.binding.storeId,
          workspaceId: context.binding.workspaceId,
          clientNamespace: context.binding.clientNamespace,
        }),
        sessionId: current.sessionId,
        ownerGeneration: nextGeneration.toString(),
        continuityKey: authority.rootContinuityKey(current),
        state: "active",
        resumedFromSessionId: current.sessionId,
        latestCheckpointEventPosition: current.latestCheckpointEventPosition?.toString() ?? null,
        eventPosition: finalPosition.toString(),
        handleIssued: true,
        resumeTokenIssued: true,
        contextPackUnavailable: true,
      });
      const events: Array<{
        eventType: string;
        eventSchemaVersion: number;
        occurredAt: string;
        visibilityScope: "session";
        sessionId: string;
        confidence: "high";
        verificationStatus: "verified";
        payload: JsonValue;
        sourceRefs: string[];
        evidenceRefs: never[];
        evidenceDigests: never[];
      }> = [{
        eventType: "SessionOwnerTransferred",
        eventSchemaVersion: 1,
        occurredAt: now.timestamp,
        visibilityScope: "session",
        sessionId: current.sessionId,
        confidence: "high",
        verificationStatus: "verified",
        payload: {
          previousOwnerGeneration: Number(current.ownerGeneration),
          ownerGeneration: Number(nextGeneration),
          authorityCommitment: nextCommitment,
        },
        sourceRefs: [],
        evidenceRefs: [],
        evidenceDigests: [],
      }];
      if (aggregate.state === "suspended") {
        events.push({
          eventType: "SessionResumed",
          eventSchemaVersion: 1,
          occurredAt: now.timestamp,
          visibilityScope: "session",
          sessionId: current.sessionId,
          confidence: "high",
          verificationStatus: "verified",
          payload: { ownerGeneration: Number(nextGeneration) },
          sourceRefs: [],
          evidenceRefs: [],
          evidenceDigests: [],
        });
      }
      const authorizationRecord: PersistedLifecycleAuthorizationRecord = Object.freeze({
        ...replayExpectation,
        proof: Object.freeze(verifiedProof),
      });
      return {
        append: {
          context,
          commandId: decoded.commandId,
          idempotencyKey: decoded.idempotencyKey,
          commandType: decoded.commandType,
          correlationId: aggregate.correlationId,
          agentId: decoded.agentId,
          expectedStreamVersion: aggregate.streamVersion,
          streamId: current.streamId,
          streamType: "session",
          events,
          outbox: [],
          publicResponse: publicResult,
        },
        authorizationRecord,
        beforeAppend: (planned, currentTransaction) => {
          const first = planned.events[0];
          if (
            first === undefined
            || first.globalPosition !== transferPosition
            || planned.events.length !== Number(eventCount)
          ) invalid("INTEGRITY_FAILURE");
          const currentAuthority = rootOperations(currentTransaction);
          const currentLeases = leaseOperations(currentTransaction);
          currentLeases.releaseCurrent({
            projectId: context.binding.projectId,
            sessionId: current.sessionId,
            ownerGeneration: current.ownerGeneration!,
            ownerClientInstanceId: currentLease.ownerClientInstanceId,
            expectedLastObservedAtMs: currentLease.lastObservedAtMs,
            expectedExpiresAtMs: currentLease.expiresAtMs,
            observedNowMs: now.milliseconds,
          });
          if (!currentAuthority.compareAndSwap({
            projectId: context.binding.projectId,
            sessionId: current.sessionId,
            expectedState: current.semanticState as RootSessionState,
            expectedOwnerGeneration: current.ownerGeneration!,
            expectedChildCapabilityGeneration: null,
            expectedAuthorityCommitment: current.authorityCommitment,
            next: authorityMutation(next),
          })) throw new LifecycleError("SESSION_HANDLE_STALE");
          currentLeases.insertGeneration({
            projectId: context.binding.projectId,
            sessionId: current.sessionId,
            ownerGeneration: nextGeneration,
            ownerClientInstanceId: context.binding.clientInstanceId,
            observedNowMs: now.milliseconds,
            leaseDurationMs: OWNER_LEASE_DURATION_MS,
          });
        },
        afterAppend: (committed) => {
          if (
            committed.events.length !== Number(eventCount)
            || committed.events[0]?.globalPosition !== transferPosition
            || committed.events.at(-1)?.globalPosition !== finalPosition
          ) invalid("INTEGRITY_FAILURE");
        },
      };
    });
    const authority = this.#authority.get(
      this.#connection,
      context.binding.projectId,
      execution.authorizationRecord.targetSessionId,
    );
    if (authority === null) invalid("INTEGRITY_FAILURE");
    return Object.freeze({
      kind: "success",
      publicResult: execution.publicResult,
      authorityMaterial: workerMaterial(
        this.#capabilities,
        context,
        authority,
        execution.publicResult.ownerGeneration,
        execution.authorizationRecord.target,
      ),
    });
  }

  recoverRoot(
    context: ProjectContext,
    input: PreparedLifecycleWorkerCommand<RootRecoveryCommandV2>,
  ): WorkerLifecycleResult<RootSessionPublicResultV2> {
    const decoded = decodeLifecycleSemanticCommandDraft(input.command);
    if (decoded.commandType !== "root-recovery") invalid();
    assertSemanticCommandAuthorization(decoded, input.authorization);
    validateRecoveryContext(context, decoded);
    if (
      input.authorization.kind !== "protected"
      || input.authorization.proof !== null
      || input.authorization.approval === null
      || input.authorization.childBindingGrant !== null
      || input.authorization.authoritySessionId !== decoded.sessionId
      || input.authorization.targetSessionId !== decoded.sessionId
    ) throw new LifecycleError("LIFECYCLE_APPROVAL_INVALID");
    const approval = input.authorization.approval;
    const assertions = {
      authorizationKind: "protected" as const,
      authorizationSessionId: decoded.sessionId,
      targetSessionId: decoded.sessionId,
      projectId: context.binding.projectId,
      vaultId: context.binding.vaultId,
      storeId: context.binding.storeId,
      workspaceId: context.binding.workspaceId,
      clientNamespace: context.binding.clientNamespace,
      capabilityKind: null,
      capabilityGeneration: null,
      presentingActorRole: context.binding.actorRole,
      presentingClientInstanceId: context.binding.clientInstanceId,
      targetActorRole: "primary" as const,
      targetClientInstanceId: approval.targetClientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
    };
    const authoritative = buildLifecycleIntentWitness(decoded, assertions);
    if (authoritative.intentHash !== input.candidateIntentHash) {
      throw new LifecycleError("IDEMPOTENCY_CONFLICT");
    }
    const replayExpectation = recoveryReplayExpectation(
      context,
      decoded,
      approval,
      input.candidateIntentHash,
    );
    const execution = this.#store.execute<RootSessionPublicResultV2>({
      context,
      commandId: decoded.commandId,
      idempotencyKey: decoded.idempotencyKey,
      commandType: decoded.commandType,
      candidateIntentHash: input.candidateIntentHash,
      authoritativeIntentHash: authoritative.intentHash,
      semanticCommand: decoded,
      capabilityKind: null,
      capabilityGeneration: null,
      replayExpectation,
    }, (transaction) => {
      const now = exactNow(this.#clock);
      const issuedAtMs = BigInt(Date.parse(approval.issuedAt));
      const expiresAtMs = BigInt(Date.parse(approval.expiresAt));
      if (now.milliseconds < issuedAtMs) throw new LifecycleError("LIFECYCLE_APPROVAL_INVALID");
      if (now.milliseconds >= expiresAtMs) throw new LifecycleError("LIFECYCLE_APPROVAL_EXPIRED");
      this.#integrity.assertQuickHealthy(context);
      const authority = rootOperations(transaction);
      const leases = leaseOperations(transaction);
      const observed = authority.get(context.binding.projectId, decoded.sessionId);
      if (observed === null) throw new LifecycleError("SESSION_NOT_FOUND");
      const current = Object.freeze({ ...observed }) as SessionAuthorityRecord;
      if (
        current.sessionKind !== "root"
        || current.ownerGeneration === null
        || current.terminalEventPosition !== null
        || (current.semanticState !== "active"
          && current.semanticState !== "suspended"
          && current.semanticState !== "ending")
      ) throw new LifecycleError("SESSION_STATE_CONFLICT");
      if (current.ownerGeneration.toString() !== decoded.expectedOwnerGeneration) {
        throw new LifecycleError("SESSION_HANDLE_STALE");
      }
      const aggregateView = authority.requireFoldMatch(current);
      if (
        aggregateView.kind !== "root"
        || aggregateView.state !== current.semanticState
      ) throw new LifecycleError("CHECKPOINT_BASE_INVALID");
      requireRiskyTransitionCheckpointV1({
        authority: current,
        aggregate: aggregateView,
        checkpoint: authority.latestCheckpoint(current),
        explicitCheckpointId: decoded.preTransitionCheckpointId,
        relevantChildren: riskyTransitionChildren(authority, current),
      });
      const correlationId = aggregateView.correlationId;
      const streamVersion = aggregateView.streamVersion;
      const observedLease = leases.current(context.binding.projectId, current.sessionId);
      if (
        observedLease === null
        || observedLease.ownerGeneration !== current.ownerGeneration
        || observedLease.ownerClientInstanceId !== current.rootHandleClientInstanceId
      ) {
        invalid("INTEGRITY_FAILURE");
      }
      const currentLease = Object.freeze({ ...observedLease });
      const nextGeneration = current.ownerGeneration + 1n;
      if (nextGeneration > SQLITE_INT64_MAX || nextGeneration > BigInt(Number.MAX_SAFE_INTEGER)) {
        invalid("INTEGRITY_FAILURE");
      }
      const targetClientInstanceId = approval.targetClientInstanceId;
      const handle = this.#capabilities.prepareCapability({
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        sessionId: current.sessionId,
        kind: "root-session-handle",
        capabilityGeneration: nextGeneration.toString(),
        policyCode: "root-default-v1",
        expiryKind: "until-revoked",
        expiresAt: null,
        actorRole: "primary",
        clientInstanceId: targetClientInstanceId,
      });
      const resume = this.#capabilities.prepareCapability({
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        sessionId: current.sessionId,
        kind: "root-resume-token",
        capabilityGeneration: nextGeneration.toString(),
        policyCode: "resume-default-v1",
        expiryKind: "until-revoked",
        expiresAt: null,
        actorRole: "primary",
        clientInstanceId: null,
      });
      const recoveryPosition = authority.nextGlobalPosition();
      if (recoveryPosition < 1n || recoveryPosition > SQLITE_INT64_MAX) {
        invalid("INTEGRITY_FAILURE");
      }
      const nextProvisional: SessionAuthorityRecord = {
        ...current,
        ownerGeneration: nextGeneration,
        rootHandleCapabilityVersion: handle.claims.capabilityVersion,
        rootHandleKeyId: handle.claims.keyId,
        rootHandleIssueNonce: handle.claims.issueNonce,
        rootHandleIssuedAt: handle.claims.issuedAt,
        rootHandlePolicyCode: handle.claims.policyCode,
        rootHandleExpiryKind: handle.claims.expiryKind,
        rootHandleExpiresAt: handle.claims.expiresAt,
        rootHandleActorRole: "primary",
        rootHandleClientInstanceId: targetClientInstanceId,
        rootHandleVerifier: handle.verifier,
        rootHandleIssuanceId: this.#ids.uuid(),
        resumeTokenCapabilityVersion: resume.claims.capabilityVersion,
        resumeTokenKeyId: resume.claims.keyId,
        resumeTokenIssueNonce: resume.claims.issueNonce,
        resumeTokenIssuedAt: resume.claims.issuedAt,
        resumeTokenPolicyCode: resume.claims.policyCode,
        resumeTokenExpiryKind: resume.claims.expiryKind,
        resumeTokenExpiresAt: resume.claims.expiresAt,
        resumeTokenActorRole: "primary",
        resumeTokenVerifier: resume.verifier,
        resumeTokenIssuanceId: this.#ids.uuid(),
        authorityCommitment: "0".repeat(64),
        authorityEventPosition: recoveryPosition,
        checkpointRequiredReason: "ownership-recovery",
        checkpointRequiredEventPosition: recoveryPosition,
        updatedAt: now.timestamp,
      };
      const nextCommitment = authorityCommitment(committedAuthority(nextProvisional));
      const next = Object.freeze({
        ...nextProvisional,
        authorityCommitment: nextCommitment,
      });
      const continuityKey = authority.rootContinuityKey(current);
      const publicResult: RootSessionPublicResultV2 = Object.freeze({
        resultVersion: 2,
        project: Object.freeze({
          projectId: context.binding.projectId,
          vaultId: context.binding.vaultId,
          storeId: context.binding.storeId,
          workspaceId: context.binding.workspaceId,
          clientNamespace: context.binding.clientNamespace,
        }),
        sessionId: current.sessionId,
        ownerGeneration: nextGeneration.toString(),
        continuityKey,
        state: current.semanticState as RootSessionState,
        resumedFromSessionId: null,
        latestCheckpointEventPosition: current.latestCheckpointEventPosition?.toString() ?? null,
        eventPosition: recoveryPosition.toString(),
        handleIssued: true,
        resumeTokenIssued: true,
        contextPackUnavailable: true,
      });
      const authorizationRecord: PersistedLifecycleAuthorizationRecord = Object.freeze({
        ...replayExpectation,
      });
      return {
        append: {
          context,
          commandId: decoded.commandId,
          idempotencyKey: decoded.idempotencyKey,
          commandType: decoded.commandType,
          correlationId,
          agentId: decoded.agentId,
          expectedStreamVersion: streamVersion,
          streamId: current.streamId,
          streamType: "session",
          events: [{
            eventType: "SessionOwnershipRecovered",
            eventSchemaVersion: 1,
            occurredAt: now.timestamp,
            visibilityScope: "session",
            sessionId: current.sessionId,
            confidence: "high",
            verificationStatus: "verified",
            payload: {
              previousOwnerGeneration: Number(current.ownerGeneration),
              ownerGeneration: Number(nextGeneration),
              approvalId: approval.approvalId,
              authorityCommitment: nextCommitment,
            },
            sourceRefs: [],
            evidenceRefs: [],
            evidenceDigests: [],
          }] satisfies PendingEvent[],
          outbox: [],
          publicResponse: publicResult,
        },
        authorizationRecord,
        beforeAppend: (planned, currentTransaction) => {
          if (
            planned.events.length !== 1
            || planned.events[0]?.globalPosition !== recoveryPosition
          ) invalid("INTEGRITY_FAILURE");
          const currentAuthority = rootOperations(currentTransaction);
          const currentLeases = leaseOperations(currentTransaction);
          currentLeases.releaseCurrent({
            projectId: context.binding.projectId,
            sessionId: current.sessionId,
            ownerGeneration: current.ownerGeneration!,
            ownerClientInstanceId: currentLease.ownerClientInstanceId,
            expectedLastObservedAtMs: currentLease.lastObservedAtMs,
            expectedExpiresAtMs: currentLease.expiresAtMs,
            observedNowMs: now.milliseconds,
          });
          if (!currentAuthority.compareAndSwap({
            projectId: context.binding.projectId,
            sessionId: current.sessionId,
            expectedState: current.semanticState as RootSessionState,
            expectedOwnerGeneration: current.ownerGeneration!,
            expectedChildCapabilityGeneration: null,
            expectedAuthorityCommitment: current.authorityCommitment,
            next: authorityMutation(next),
          })) throw new LifecycleError("SESSION_HANDLE_STALE");
          currentLeases.insertGeneration({
            projectId: context.binding.projectId,
            sessionId: current.sessionId,
            ownerGeneration: nextGeneration,
            ownerClientInstanceId: targetClientInstanceId,
            observedNowMs: now.milliseconds,
            leaseDurationMs: OWNER_LEASE_DURATION_MS,
          });
        },
        afterAppend: (committed, currentTransaction) => {
          const recoveredEvent = committed.events[0];
          if (
            committed.events.length !== 1
            || recoveredEvent === undefined
            || recoveredEvent.globalPosition !== recoveryPosition
          ) invalid("INTEGRITY_FAILURE");
          approvalOperations(currentTransaction).consume({
            approvalId: approval.approvalId,
            nonceDigest: approval.nonceDigest,
            projectId: context.binding.projectId,
            sessionId: current.sessionId,
            action: "recover-root-authority",
            commandId: decoded.commandId,
            targetActorRole: "primary",
            targetClientInstanceId,
            redactedApprovalReference: approval.redactedApprovalReference,
            consumedEventPosition: recoveredEvent.globalPosition,
            consumedAtMs: now.milliseconds,
          });
        },
      };
    });
    const authority = this.#authority.get(
      this.#connection,
      context.binding.projectId,
      execution.authorizationRecord.targetSessionId,
    );
    if (authority === null) invalid("INTEGRITY_FAILURE");
    return Object.freeze({
      kind: "success",
      publicResult: execution.publicResult,
      authorityMaterial: workerMaterial(
        this.#capabilities,
        context,
        authority,
        execution.publicResult.ownerGeneration,
        execution.authorizationRecord.target,
      ),
    });
  }

  suspendRoot(
    context: ProjectContext,
    input: PreparedLifecycleWorkerCommand<RootSuspendCommandV2 | RootSuspendCommandV3>,
  ): WorkerLifecycleResult<RootSessionPublicResultV2> {
    const decoded = decodeLifecycleSemanticCommandDraft(input.command);
    if (decoded.commandType !== "root-suspend") invalid();
    const command = decoded;
    assertSemanticCommandAuthorization(command, input.authorization);
    validateContext(context, command);
    if (
      input.authorization.kind !== "protected"
      || input.authorization.proof === null
      || input.authorization.approval !== null
      || input.authorization.childBindingGrant !== null
      || input.authorization.authoritySessionId !== command.sessionId
      || input.authorization.targetSessionId !== command.sessionId
    ) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
    const proof = input.authorization.proof;
    const proofBytes = Buffer.from(proof.proofFingerprint, "hex");
    let proofDigest: string;
    try {
      if (proofBytes.length !== 32) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
      proofDigest = capabilityProofDigest(proofBytes);
    } finally {
      proofBytes.fill(0);
    }
    const principal = Object.freeze({
      actorRole: "primary" as const,
      clientInstanceId: context.binding.clientInstanceId,
    });
    const replayExpectation: Extract<LifecycleReplayExpectation, { kind: "protected" }> = Object.freeze({
      kind: "protected",
      proof: Object.freeze({
        version: 1,
        nonce: proof.proofNonce,
        digest: proofDigest,
      }),
      approval: null,
      authorizationSessionId: decoded.sessionId,
      targetSessionId: decoded.sessionId,
      presenting: principal,
      target: principal,
    });
    const execution = this.#store.execute<RootSessionPublicResultV2>({
      context,
      commandId: decoded.commandId,
      idempotencyKey: decoded.idempotencyKey,
      commandType: decoded.commandType,
      candidateIntentHash: input.candidateIntentHash,
      authoritativeIntentHash: input.candidateIntentHash,
      semanticCommand: decoded,
      capabilityKind: "root-session-handle",
      capabilityGeneration: null,
      capabilityGenerationResolution: "fresh-commit",
      replayExpectation,
    }, (transaction) => {
      const authority = rootOperations(transaction);
      const leases = leaseOperations(transaction);
      const now = exactNow(this.#clock);
      const observed = authority.get(context.binding.projectId, decoded.sessionId);
      if (observed === null) throw new LifecycleError("SESSION_NOT_FOUND");
      const current = Object.freeze({ ...observed }) as SessionAuthorityRecord;
      if (
        current.sessionKind !== "root"
        || current.ownerGeneration === null
        || current.semanticState !== "active"
      ) throw new LifecycleError("SESSION_STATE_CONFLICT");
      if (current.rootHandleClientInstanceId !== context.binding.clientInstanceId) {
        throw new LifecycleError("SESSION_HANDLE_STALE");
      }
      const aggregateView = authority.requireFoldMatch(current);
      if (aggregateView.kind !== "root" || aggregateView.state !== "active") {
        throw new LifecycleError("SESSION_STATE_CONFLICT");
      }
      authority.latestCheckpoint(current);
      const streamVersion = aggregateView.streamVersion;
      const priorEventPosition = aggregateView.eventPosition;
      const correlationId = aggregateView.correlationId;
      if (BigInt(decoded.expectedStreamVersion) !== streamVersion) {
        throw new LifecycleError("EVENT_CONFLICT");
      }
      const generation = current.ownerGeneration.toString();
      const assertions = {
        authorizationKind: "protected" as const,
        authorizationSessionId: decoded.sessionId,
        targetSessionId: decoded.sessionId,
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        capabilityKind: "root-session-handle" as const,
        capabilityGeneration: generation,
        presentingActorRole: "primary" as const,
        presentingClientInstanceId: context.binding.clientInstanceId,
        targetActorRole: "primary" as const,
        targetClientInstanceId: context.binding.clientInstanceId,
        internalWorkflowId: null,
        internalWorkflowGeneration: null,
        internalPlannedWorkId: null,
      };
      const authoritative = buildLifecycleIntentWitness(decoded, assertions);
      if (!LOWER_HASH.test(input.candidateIntentHash)
        || authoritative.intentHash !== input.candidateIntentHash) {
        throw new LifecycleError("IDEMPOTENCY_CONFLICT");
      }
      const handleMaterial = materialFromAuthority(context, current).find(
        (material) => material.claims.kind === "root-session-handle",
      );
      if (handleMaterial === undefined) invalid("INTEGRITY_FAILURE");
      const proofTarget: SemanticCommandProofTargetV1 = {
        proofVersion: 1,
        target: "semantic-command",
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        authoritySessionId: decoded.sessionId,
        targetSessionId: decoded.sessionId,
        presentingActorRole: "primary",
        presentingClientInstanceId: context.binding.clientInstanceId,
        targetActorRole: "primary",
        targetClientInstanceId: context.binding.clientInstanceId,
        capabilityKind: "root-session-handle",
        capabilityGeneration: generation,
        commandId: decoded.commandId,
        idempotencyKey: decoded.idempotencyKey,
        intentHash: authoritative.intentHash,
        proofNonce: proof.proofNonce,
      };
      const verifiedProof = this.#capabilities.verifyProof(handleMaterial, proofTarget, proof);
      if (verifiedProof.digest !== proofDigest) invalid("INTEGRITY_FAILURE");
      const observedLease = leases.current(context.binding.projectId, current.sessionId);
      if (observedLease === null) invalid("INTEGRITY_FAILURE");
      const currentLease = Object.freeze({ ...observedLease });
      if (
        currentLease.ownerGeneration !== current.ownerGeneration
        || currentLease.ownerClientInstanceId !== context.binding.clientInstanceId
      ) throw new LifecycleError("SESSION_HANDLE_STALE");

      const checkpointPosition = authority.nextGlobalPosition();
      if (checkpointPosition < 2n || checkpointPosition > SQLITE_INT64_MAX - 2n) {
        invalid("INTEGRITY_FAILURE");
      }
      const baseEventPosition = checkpointPosition - 1n;
      if (baseEventPosition < priorEventPosition) invalid("INTEGRITY_FAILURE");
      const suspendRequestPosition = checkpointPosition + 1n;
      const suspendedPosition = checkpointPosition + 2n;
      const sourceStateScope = this.#checkpointSourceStateScopes.resolve(this.#connection, context);
      const preparedCheckpoint = this.#checkpoints.prepareRootSuspension(transaction, {
        context,
        command,
        sourceStateScope,
        authority: current,
        aggregate: aggregateView,
        baseEventPosition,
        checkpointEventPosition: checkpointPosition,
        createdAt: now.timestamp,
      });
      const checkpoint = preparedCheckpoint.checkpoint;
      const checkpointFingerprint = preparedCheckpoint.checkpointFingerprint;
      const continuityKey = authority.rootContinuityKey(current);
      const rotatedHandle = this.#capabilities.prepareCapability({
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        sessionId: current.sessionId,
        kind: "root-session-handle",
        capabilityGeneration: generation,
        policyCode: "root-default-v1",
        expiryKind: "until-revoked",
        expiresAt: null,
        actorRole: "primary",
        clientInstanceId: context.binding.clientInstanceId,
      });
      const nextProvisional: SessionAuthorityRecord = {
        ...current,
        semanticState: "suspended",
        rootHandleCapabilityVersion: rotatedHandle.claims.capabilityVersion,
        rootHandleKeyId: rotatedHandle.claims.keyId,
        rootHandleIssueNonce: rotatedHandle.claims.issueNonce,
        rootHandleIssuedAt: rotatedHandle.claims.issuedAt,
        rootHandlePolicyCode: rotatedHandle.claims.policyCode,
        rootHandleExpiryKind: rotatedHandle.claims.expiryKind,
        rootHandleExpiresAt: rotatedHandle.claims.expiresAt,
        rootHandleActorRole: "primary",
        rootHandleClientInstanceId: context.binding.clientInstanceId,
        rootHandleVerifier: rotatedHandle.verifier,
        rootHandleIssuanceId: this.#ids.uuid(),
        authorityEventPosition: suspendedPosition,
        latestCheckpointId: checkpoint.checkpointId,
        latestCheckpointEventPosition: checkpointPosition,
        latestCheckpointFingerprint: checkpointFingerprint,
        checkpointRequiredReason: "suspension",
        checkpointRequiredEventPosition: suspendedPosition,
        updatedAt: now.timestamp,
      };
      const nextCommitment = authorityCommitment(committedAuthority(nextProvisional));
      const next = Object.freeze({
        ...nextProvisional,
        authorityCommitment: nextCommitment,
      });
      const publicResult: RootSessionPublicResultV2 = Object.freeze({
        resultVersion: 2,
        project: Object.freeze({
          projectId: context.binding.projectId,
          vaultId: context.binding.vaultId,
          storeId: context.binding.storeId,
          workspaceId: context.binding.workspaceId,
          clientNamespace: context.binding.clientNamespace,
        }),
        sessionId: current.sessionId,
        ownerGeneration: generation,
        continuityKey,
        state: "suspended",
        resumedFromSessionId: null,
        latestCheckpointEventPosition: checkpointPosition.toString(),
        eventPosition: suspendedPosition.toString(),
        handleIssued: true,
        resumeTokenIssued: true,
        contextPackUnavailable: true,
      });
      const authorizationRecord: PersistedLifecycleAuthorizationRecord = Object.freeze({
        ...replayExpectation,
        proof: Object.freeze(verifiedProof),
      });
      return {
        append: {
          context,
          commandId: decoded.commandId,
          idempotencyKey: decoded.idempotencyKey,
          commandType: decoded.commandType,
          correlationId,
          agentId: decoded.agentId,
          expectedStreamVersion: streamVersion,
          streamId: current.streamId,
          streamType: "session",
          events: [preparedCheckpoint.event, {
            eventType: "SessionSuspendRequested",
            eventSchemaVersion: 1,
            occurredAt: now.timestamp,
            visibilityScope: "session",
            sessionId: current.sessionId,
            confidence: "high",
            verificationStatus: "verified",
            payload: { checkpointId: checkpoint.checkpointId } as JsonValue,
            sourceRefs: [],
            evidenceRefs: [],
            evidenceDigests: [],
          }, {
            eventType: "SessionSuspended",
            eventSchemaVersion: 1,
            occurredAt: now.timestamp,
            visibilityScope: "session",
            sessionId: current.sessionId,
            confidence: "high",
            verificationStatus: "verified",
            payload: { authorityCommitment: nextCommitment } as JsonValue,
            sourceRefs: [],
            evidenceRefs: [],
            evidenceDigests: [],
          }] satisfies PendingEvent[],
          outbox: [],
          publicResponse: publicResult,
        },
        authorizationRecord,
        freshCapabilityGeneration: generation,
        beforeAppend: (planned) => {
          if (
            planned.events.length !== 3
            || planned.events[0]?.globalPosition !== checkpointPosition
            || planned.events[1]?.globalPosition !== suspendRequestPosition
            || planned.events[2]?.globalPosition !== suspendedPosition
          ) invalid("INTEGRITY_FAILURE");
        },
        afterAppend: (committed, currentTransaction) => {
          if (
            committed.events.length !== 3
            || committed.events[0]?.globalPosition !== checkpointPosition
            || committed.events[1]?.globalPosition !== suspendRequestPosition
            || committed.events[2]?.globalPosition !== suspendedPosition
          ) invalid("INTEGRITY_FAILURE");
          const currentAuthority = rootOperations(currentTransaction);
          const currentLeases = leaseOperations(currentTransaction);
          if (!currentAuthority.compareAndSwap({
            projectId: context.binding.projectId,
            sessionId: current.sessionId,
            expectedState: "active",
            expectedOwnerGeneration: current.ownerGeneration!,
            expectedChildCapabilityGeneration: null,
            expectedAuthorityCommitment: current.authorityCommitment,
            next: authorityMutation(next),
          })) throw new LifecycleError("SESSION_HANDLE_STALE");
          currentLeases.renewCurrent({
            projectId: context.binding.projectId,
            sessionId: current.sessionId,
            ownerGeneration: current.ownerGeneration!,
            ownerClientInstanceId: context.binding.clientInstanceId,
            observedNowMs: now.milliseconds,
            leaseDurationMs: OWNER_LEASE_DURATION_MS,
          });
        },
      };
    });
    const authority = this.#authority.get(
      this.#connection,
      context.binding.projectId,
      execution.authorizationRecord.targetSessionId,
    );
    if (authority === null) invalid("INTEGRITY_FAILURE");
    return Object.freeze({
      kind: "success",
      publicResult: execution.publicResult,
      authorityMaterial: workerMaterial(
        this.#capabilities,
        context,
        authority,
        execution.publicResult.ownerGeneration,
        execution.authorizationRecord.target,
      ),
    });
  }

  requestSessionEnd(
    context: ProjectContext,
    input: PreparedLifecycleWorkerCommand<
      RequestSessionEndCommandV2 | RequestSessionEndCommandV3
    >,
  ): WorkerLifecycleResult<SessionEndStatusV2> {
    const decoded = decodeLifecycleSemanticCommandDraft(input.command);
    if (decoded.commandType !== "request-session-end") invalid();
    const command = decoded;
    assertSemanticCommandAuthorization(command, input.authorization);
    validateContext(context, command);
    if (
      input.authorization.kind !== "protected"
      || input.authorization.proof === null
      || input.authorization.approval !== null
      || input.authorization.childBindingGrant !== null
      || input.authorization.authoritySessionId !== command.request.sessionId
      || input.authorization.targetSessionId !== command.request.sessionId
    ) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
    if (!LOWER_HASH.test(input.candidateIntentHash)) {
      throw new LifecycleError("IDEMPOTENCY_CONFLICT");
    }
    const proof = input.authorization.proof;
    const proofBytes = Buffer.from(proof.proofFingerprint, "hex");
    let proofDigest: string;
    try {
      if (proofBytes.length !== 32) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
      proofDigest = capabilityProofDigest(proofBytes);
    } finally {
      proofBytes.fill(0);
    }
    const principal = Object.freeze({
      actorRole: "primary" as const,
      clientInstanceId: context.binding.clientInstanceId,
    });
    const replayExpectation: Extract<LifecycleReplayExpectation, { kind: "protected" }> = Object.freeze({
      kind: "protected",
      proof: Object.freeze({
        version: 1,
        nonce: proof.proofNonce,
        digest: proofDigest,
      }),
      approval: null,
      authorizationSessionId: command.request.sessionId,
      targetSessionId: command.request.sessionId,
      presenting: principal,
      target: principal,
    });
    const execution = this.#store.execute<SessionEndStatusV2>({
      context,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      commandType: command.commandType,
      candidateIntentHash: input.candidateIntentHash,
      authoritativeIntentHash: input.candidateIntentHash,
      semanticCommand: command,
      capabilityKind: "root-session-handle",
      capabilityGeneration: null,
      capabilityGenerationResolution: "fresh-commit",
      replayExpectation,
    }, (transaction) => {
      this.#integrity.assertQuickHealthy(context);
      const authority = rootOperations(transaction);
      const leases = leaseOperations(transaction);
      const now = exactNow(this.#clock);
      const observed = authority.get(context.binding.projectId, command.request.sessionId);
      if (observed === null) throw new LifecycleError("SESSION_NOT_FOUND");
      const current = Object.freeze({ ...observed }) as SessionAuthorityRecord;
      if (
        current.sessionKind !== "root"
        || current.parentSessionId !== null
        || current.ownerGeneration === null
        || current.terminalEventPosition !== null
        || (current.semanticState !== "active" && current.semanticState !== "suspended")
      ) throw new LifecycleError("SESSION_STATE_CONFLICT");
      if (current.rootHandleClientInstanceId !== context.binding.clientInstanceId) {
        throw new LifecycleError("SESSION_HANDLE_STALE");
      }
      const aggregate = authority.requireFoldMatch(current);
      if (
        aggregate.kind !== "root"
        || aggregate.state !== current.semanticState
        || aggregate.terminalEventPosition !== null
      ) throw new LifecycleError("SESSION_STATE_CONFLICT");
      const currentLease = leases.current(context.binding.projectId, current.sessionId);
      if (
        currentLease === null
        || currentLease.ownerGeneration !== current.ownerGeneration
        || currentLease.ownerClientInstanceId !== context.binding.clientInstanceId
      ) throw new LifecycleError("SESSION_HANDLE_STALE");

      const generation = current.ownerGeneration.toString();
      const assertions = {
        authorizationKind: "protected" as const,
        authorizationSessionId: command.request.sessionId,
        targetSessionId: command.request.sessionId,
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        capabilityKind: "root-session-handle" as const,
        capabilityGeneration: generation,
        presentingActorRole: "primary" as const,
        presentingClientInstanceId: context.binding.clientInstanceId,
        targetActorRole: "primary" as const,
        targetClientInstanceId: context.binding.clientInstanceId,
        internalWorkflowId: null,
        internalWorkflowGeneration: null,
        internalPlannedWorkId: null,
      };
      const authoritative = buildLifecycleIntentWitness(command, assertions);
      if (authoritative.intentHash !== input.candidateIntentHash) {
        throw new LifecycleError("IDEMPOTENCY_CONFLICT");
      }
      const handleMaterial = materialFromAuthority(context, current).find(
        (material) => material.claims.kind === "root-session-handle",
      );
      if (handleMaterial === undefined) invalid("INTEGRITY_FAILURE");
      const proofTarget: SemanticCommandProofTargetV1 = {
        proofVersion: 1,
        target: "semantic-command",
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        authoritySessionId: command.request.sessionId,
        targetSessionId: command.request.sessionId,
        presentingActorRole: "primary",
        presentingClientInstanceId: context.binding.clientInstanceId,
        targetActorRole: "primary",
        targetClientInstanceId: context.binding.clientInstanceId,
        capabilityKind: "root-session-handle",
        capabilityGeneration: generation,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        intentHash: authoritative.intentHash,
        proofNonce: proof.proofNonce,
      };
      const verifiedProof = this.#capabilities.verifyProof(handleMaterial, proofTarget, proof);
      if (verifiedProof.digest !== proofDigest) invalid("INTEGRITY_FAILURE");

      const relevantChildren = riskyTransitionChildren(authority, current);
      if (
        command.request.childEndPolicy === "require-completed"
        && relevantChildren.some(({ aggregate: childAggregate }) => (
          childAggregate.kind === "child"
          && (childAggregate.state === "active"
            || childAggregate.state === "completion-proposed"
            || childAggregate.state === "suspended")
        ))
      ) throw new LifecycleError("SESSION_CHILDREN_ACTIVE");
      const checkpoint = requireRiskyTransitionCheckpointV1({
        authority: current,
        aggregate,
        checkpoint: authority.latestCheckpoint(current),
        relevantChildren,
      });
      const currentSourceState = this.#resumeSourceState.captureCurrent(context);
      if (canonicalJson(currentSourceState) !== canonicalJson(checkpoint.sourceState)) {
        throw new LifecycleError("SESSION_SOURCE_STATE_CONFLICT");
      }
      assertRootChildHistoryCapacity(
        this.#connection,
        current,
        command.request.childEndPolicy,
      );
      const endingScopeBindings = requestEndingScopeBindings(
        transaction,
        current,
        relevantChildren,
      );
      if (command.request.requestVersion === 1) {
        const eligibleWholeScope = [
          current.sessionId as SessionId,
          ...endingScopeBindings.map((binding) => binding.childSessionId as SessionId),
        ];
        transaction.coverage.assertVersion1Eligible(Object.freeze(eligibleWholeScope));
      }
      const evidenceCoverage = transaction.coverage.snapshotV2(
        current.sessionId as SessionId,
        aggregate.eventPosition,
      );
      const minimumCheckpointBytes = transaction.coverage.minimumCheckpointUpperBound({
        evidenceCoverage,
        endingScopeBindings,
      });
      const minimumEndingScopeBytes = transaction.coverage.minimumFinalEndingScopeBindingsUpperBound({
        endingScopeBindings,
      });
      if (
        !Number.isSafeInteger(minimumCheckpointBytes)
        || minimumCheckpointBytes < 0
        || !Number.isSafeInteger(minimumEndingScopeBytes)
        || minimumEndingScopeBytes < 0
      ) invalid("INTEGRITY_FAILURE");
      if (
        minimumCheckpointBytes > CHECKPOINT_MAX_CANONICAL_BYTES
        || minimumEndingScopeBytes > FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES
      ) throw new LifecycleError("CHECKPOINT_CAPACITY_EXCEEDED");

      const policyInput = this.#sessionEndPolicy.resolve(context, command.request);
      const effectivePolicy = persistedQualityPolicy(
        deriveEffectiveQualityPolicyV1(policyInput),
      );
      const effectiveState = createSessionEndEffectiveStateV1({
        request: command.request,
        effectivePolicy,
      });
      const workflowId = sessionEndWorkflowId(current.sessionId as SessionId);
      const existing = this.#sessionEndWorkflows.read(context.binding.projectId, workflowId);
      if (existing !== null && existing.sessionId !== current.sessionId) {
        invalid("INTEGRITY_FAILURE");
      }
      let workflowGeneration = 1;
      if (existing !== null) {
        if (existing.phase !== "cancelled") {
          throw new LifecycleError("SESSION_END_INCOMPLETE");
        }
        if (existing.generation >= Number.MAX_SAFE_INTEGER) invalid("INTEGRITY_FAILURE");
        workflowGeneration = existing.generation + 1;
      }
      const eventPosition = authority.nextGlobalPosition();
      if (eventPosition <= aggregate.eventPosition || eventPosition > SQLITE_INT64_MAX) {
        invalid("INTEGRITY_FAILURE");
      }
      const evidenceWindowState = initialSessionEndEvidenceWindowStateV1(command.request);
      const status = requestedSessionEndStatusV2({
        sessionId: current.sessionId,
        workflowId,
        workflowGeneration,
        priorRootState: current.semanticState,
        triggeringEventPosition: eventPosition,
        evidenceWindowState,
        materializationRequired: effectivePolicy.requireMaterialization,
      });
      const nextAuthority = Object.freeze({
        ...current,
        semanticState: "ending" as const,
        updatedAt: now.timestamp,
      });
      const authorizationRecord: PersistedLifecycleAuthorizationRecord = Object.freeze({
        ...replayExpectation,
        proof: Object.freeze(verifiedProof),
      });
      const requestedInput = {
        projectId: current.projectId,
        workflowId,
        workflowGeneration,
        rootCommandId: command.commandId,
        sessionId: current.sessionId,
        triggeringEventPosition: eventPosition,
        expectedAuthorityCommitment: current.authorityCommitment,
        priorRootState: current.semanticState,
        resultJson: existing === null ? canonicalJson(status) : null,
        evidenceWindowState,
        now: now.timestamp,
        effectiveState,
      } as const;
      return {
        append: {
          context,
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          commandType: command.commandType,
          correlationId: aggregate.correlationId,
          agentId: command.agentId,
          expectedStreamVersion: aggregate.streamVersion,
          streamId: current.streamId,
          streamType: "session",
          events: [{
            eventType: "SessionEndRequested",
            eventSchemaVersion: 3,
            occurredAt: now.timestamp,
            visibilityScope: "session",
            sessionId: current.sessionId,
            confidence: "high",
            verificationStatus: "verified",
            payload: {
              workflowId,
              workflowGeneration,
              previousState: current.semanticState,
              effectiveState,
            } as unknown as JsonValue,
            sourceRefs: [],
            evidenceRefs: [],
            evidenceDigests: [],
          }],
          outbox: [],
          publicResponse: status,
        },
        authorizationRecord,
        freshCapabilityGeneration: generation,
        beforeAppend: (planned) => {
          if (planned.events.length !== 1 || planned.events[0]?.globalPosition !== eventPosition) {
            invalid("INTEGRITY_FAILURE");
          }
        },
        afterAppend: (committed, currentTransaction) => {
          if (committed.events.length !== 1 || committed.events[0]?.globalPosition !== eventPosition) {
            invalid("INTEGRITY_FAILURE");
          }
          const currentAuthority = rootOperations(currentTransaction);
          const currentLeases = leaseOperations(currentTransaction);
          if (!currentAuthority.compareAndSwap({
            projectId: current.projectId,
            sessionId: current.sessionId,
            expectedState: current.semanticState as "active" | "suspended",
            expectedOwnerGeneration: current.ownerGeneration!,
            expectedChildCapabilityGeneration: null,
            expectedAuthorityCommitment: current.authorityCommitment,
            next: authorityMutation(nextAuthority),
          })) throw new LifecycleError("SESSION_HANDLE_STALE");
          if (existing === null) {
            this.#sessionEndWorkflows.createRequested(requestedInput);
          } else {
            this.#sessionEndWorkflows.reopenCancelled(requestedInput);
          }
          currentLeases.renewCurrent({
            projectId: current.projectId,
            sessionId: current.sessionId,
            ownerGeneration: current.ownerGeneration!,
            ownerClientInstanceId: context.binding.clientInstanceId,
            observedNowMs: now.milliseconds,
            leaseDurationMs: OWNER_LEASE_DURATION_MS,
          });
        },
      };
    });
    const authority = this.#authority.get(
      this.#connection,
      context.binding.projectId,
      execution.authorizationRecord.targetSessionId,
    );
    if (authority === null || authority.ownerGeneration === null) invalid("INTEGRITY_FAILURE");
    return Object.freeze({
      kind: "success",
      publicResult: execution.publicResult,
      authorityMaterial: workerMaterial(
        this.#capabilities,
        context,
        authority,
        authority.ownerGeneration.toString(),
        execution.authorizationRecord.target,
      ),
    });
  }

  amendSessionEnd(
    context: ProjectContext,
    input: PreparedLifecycleWorkerCommand<AmendSessionEndCommandV2 | AmendSessionEndCommandV3>,
  ): WorkerLifecycleResult<SessionEndStatusV2> {
    const decoded = decodeLifecycleSemanticCommandDraft(input.command);
    if (decoded.commandType !== "amend-session-end") invalid();
    const command = decoded;
    assertSemanticCommandAuthorization(command, input.authorization);
    validateContext(context, command);
    if (
      input.authorization.kind !== "protected"
      || input.authorization.proof === null
      || input.authorization.approval !== null
      || input.authorization.childBindingGrant !== null
      || input.authorization.authoritySessionId !== command.sessionId
      || input.authorization.targetSessionId !== command.sessionId
    ) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
    if (!LOWER_HASH.test(input.candidateIntentHash)) {
      throw new LifecycleError("IDEMPOTENCY_CONFLICT");
    }
    const proof = input.authorization.proof;
    const proofBytes = Buffer.from(proof.proofFingerprint, "hex");
    let proofDigest: string;
    try {
      if (proofBytes.length !== 32) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
      proofDigest = capabilityProofDigest(proofBytes);
    } finally {
      proofBytes.fill(0);
    }
    const principal = Object.freeze({
      actorRole: "primary" as const,
      clientInstanceId: context.binding.clientInstanceId,
    });
    const replayExpectation: Extract<LifecycleReplayExpectation, { kind: "protected" }> = Object.freeze({
      kind: "protected",
      proof: Object.freeze({
        version: 1,
        nonce: proof.proofNonce,
        digest: proofDigest,
      }),
      approval: null,
      authorizationSessionId: command.sessionId,
      targetSessionId: command.sessionId,
      presenting: principal,
      target: principal,
    });
    const execution = this.#store.execute<SessionEndStatusV2>({
      context,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      commandType: command.commandType,
      candidateIntentHash: input.candidateIntentHash,
      authoritativeIntentHash: input.candidateIntentHash,
      semanticCommand: command,
      capabilityKind: "root-session-handle",
      capabilityGeneration: null,
      capabilityGenerationResolution: "fresh-commit",
      replayExpectation,
    }, (transaction) => {
      this.#integrity.assertQuickHealthy(context);
      const authority = rootOperations(transaction);
      const leases = leaseOperations(transaction);
      const now = exactNow(this.#clock);
      const observed = authority.get(context.binding.projectId, command.sessionId);
      if (observed === null) throw new LifecycleError("SESSION_NOT_FOUND");
      const current = Object.freeze({ ...observed }) as SessionAuthorityRecord;
      if (
        current.sessionKind !== "root"
        || current.parentSessionId !== null
        || current.ownerGeneration === null
        || current.terminalEventPosition !== null
        || current.semanticState !== "ending"
        || current.rootHandleClientInstanceId !== context.binding.clientInstanceId
      ) throw new LifecycleError("SESSION_STATE_CONFLICT");
      const aggregate = authority.requireFoldMatch(current);
      if (
        aggregate.kind !== "root"
        || aggregate.state !== "ending"
        || aggregate.terminalEventPosition !== null
        || BigInt(command.expectedStreamVersion) !== aggregate.streamVersion
      ) throw new LifecycleError("SESSION_STATE_CONFLICT");
      const currentLease = leases.current(context.binding.projectId, current.sessionId);
      if (
        currentLease === null
        || currentLease.ownerGeneration !== current.ownerGeneration
        || currentLease.ownerClientInstanceId !== context.binding.clientInstanceId
      ) throw new LifecycleError("SESSION_HANDLE_STALE");
      const generation = current.ownerGeneration.toString();
      const assertions = {
        authorizationKind: "protected" as const,
        authorizationSessionId: command.sessionId,
        targetSessionId: command.sessionId,
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        capabilityKind: "root-session-handle" as const,
        capabilityGeneration: generation,
        presentingActorRole: "primary" as const,
        presentingClientInstanceId: context.binding.clientInstanceId,
        targetActorRole: "primary" as const,
        targetClientInstanceId: context.binding.clientInstanceId,
        internalWorkflowId: null,
        internalWorkflowGeneration: null,
        internalPlannedWorkId: null,
      };
      const authoritative = buildLifecycleIntentWitness(command, assertions);
      if (authoritative.intentHash !== input.candidateIntentHash) {
        throw new LifecycleError("IDEMPOTENCY_CONFLICT");
      }
      const handleMaterial = materialFromAuthority(context, current).find(
        (material) => material.claims.kind === "root-session-handle",
      );
      if (handleMaterial === undefined) invalid("INTEGRITY_FAILURE");
      const proofTarget: SemanticCommandProofTargetV1 = {
        proofVersion: 1,
        target: "semantic-command",
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        authoritySessionId: command.sessionId,
        targetSessionId: command.sessionId,
        presentingActorRole: "primary",
        presentingClientInstanceId: context.binding.clientInstanceId,
        targetActorRole: "primary",
        targetClientInstanceId: context.binding.clientInstanceId,
        capabilityKind: "root-session-handle",
        capabilityGeneration: generation,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        intentHash: authoritative.intentHash,
        proofNonce: proof.proofNonce,
      };
      const verifiedProof = this.#capabilities.verifyProof(handleMaterial, proofTarget, proof);
      if (verifiedProof.digest !== proofDigest) invalid("INTEGRITY_FAILURE");

      const workflowId = sessionEndWorkflowId(current.sessionId as SessionId);
      if (command.workflowId !== workflowId) throw new LifecycleError("SESSION_STATE_CONFLICT");
      const existing = this.#sessionEndWorkflows.read(context.binding.projectId, workflowId);
      if (
        existing === null
        || existing.sessionId !== current.sessionId
        || existing.phase === "cancelled"
        || existing.phase === "abandoned"
        || existing.phase === "completed"
        || aggregate.endWorkflowId !== workflowId
        || aggregate.endWorkflowGeneration !== existing.generation
      ) throw new LifecycleError("SESSION_END_INCOMPLETE");
      const hydrated = this.#sessionEndWorkflows.hydrateEffectiveStateV1({
        projectId: current.projectId,
        workflowId,
        workflowGeneration: existing.generation,
        sessionId: current.sessionId,
      });
      const relevantChildren = riskyTransitionChildren(authority, current);
      const checkpoint = requireRiskyTransitionCheckpointV1({
        authority: current,
        aggregate,
        checkpoint: authority.latestCheckpoint(current),
        allowTrailingRootEvents: true,
        relevantChildren,
      });
      const currentSourceState = this.#resumeSourceState.captureCurrent(context);
      if (canonicalJson(currentSourceState) !== canonicalJson(checkpoint.sourceState)) {
        throw new LifecycleError("SESSION_SOURCE_STATE_CONFLICT");
      }
      const amendment = command.amendment;
      const evidenceWindowAction = amendment.amendmentVersion === 1
        ? "unchanged" as const
        : amendment.evidenceWindowAction;
      if (evidenceWindowAction === "open" && existing.evidenceWindowState !== "sealed") {
        throw new LifecycleError("SESSION_END_EVIDENCE_WINDOW_OPEN");
      }
      if (evidenceWindowAction === "seal" && existing.evidenceWindowState !== "open") {
        throw new LifecycleError("SESSION_END_EVIDENCE_FROZEN");
      }
      const provisional = foldSessionEndAmendmentV1({
        previous: hydrated.effectiveState,
        amendment,
        effectivePolicy: hydrated.effectiveState.effectivePolicy,
      });
      const policyInput = this.#sessionEndPolicy.resolve(context, provisional.request);
      const effectivePolicy = persistedQualityPolicy(
        deriveEffectiveQualityPolicyV1(policyInput),
      );
      const effectiveState = foldSessionEndAmendmentV1({
        previous: hydrated.effectiveState,
        amendment,
        effectivePolicy,
      });
      const requestChanged = canonicalJson(hydrated.effectiveState.request)
        !== canonicalJson(effectiveState.request);
      const policyChanged = canonicalJson(hydrated.effectiveState.effectivePolicy)
        !== canonicalJson(effectiveState.effectivePolicy);
      if (
        evidenceWindowAction === "unchanged"
        && (requestChanged || policyChanged)
        && existing.phase !== "requested"
        && existing.phase !== "children-resolved"
      ) throw new LifecycleError("SESSION_END_INCOMPLETE");
      if (evidenceWindowAction === "seal") {
        if (effectiveState.request.requestVersion !== 2 || checkpoint.checkpointVersion !== 2) {
          throw new LifecycleError("CHECKPOINT_EVIDENCE_VERSION_REQUIRED");
        }
        const evidenceCoverage = transaction.coverage.snapshotV2(
          current.sessionId as SessionId,
          aggregate.eventPosition,
        );
        if (canonicalJson(evidenceCoverage) !== canonicalJson(checkpoint.evidenceCoverage)) {
          throw new LifecycleError("SESSION_END_COVERAGE_CHANGED");
        }
      }
      if (
        effectiveState.request.childEndPolicy === "require-completed"
        && relevantChildren.some(({ aggregate: childAggregate }) => (
          childAggregate.kind === "child"
          && (childAggregate.state === "active"
            || childAggregate.state === "completion-proposed"
            || childAggregate.state === "suspended")
        ))
      ) throw new LifecycleError("SESSION_CHILDREN_ACTIVE");
      assertRootChildHistoryCapacity(
        this.#connection,
        current,
        effectiveState.request.childEndPolicy,
      );
      const endingScopeBindings = requestEndingScopeBindings(
        transaction,
        current,
        relevantChildren,
      );
      if (amendment.amendmentVersion === 1) {
        const wholeScope = [
          current.sessionId as SessionId,
          ...endingScopeBindings.map((binding) => binding.childSessionId as SessionId),
        ];
        transaction.coverage.assertVersion1Eligible(Object.freeze(wholeScope));
      }
      const evidenceCoverage = transaction.coverage.snapshotV2(
        current.sessionId as SessionId,
        aggregate.eventPosition,
      );
      const minimumCheckpointBytes = transaction.coverage.minimumCheckpointUpperBound({
        evidenceCoverage,
        endingScopeBindings,
      });
      const minimumEndingScopeBytes = transaction.coverage.minimumFinalEndingScopeBindingsUpperBound({
        endingScopeBindings,
      });
      if (
        !Number.isSafeInteger(minimumCheckpointBytes)
        || minimumCheckpointBytes < 0
        || !Number.isSafeInteger(minimumEndingScopeBytes)
        || minimumEndingScopeBytes < 0
      ) invalid("INTEGRITY_FAILURE");
      if (
        minimumCheckpointBytes > CHECKPOINT_MAX_CANONICAL_BYTES
        || minimumEndingScopeBytes > FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES
      ) throw new LifecycleError("CHECKPOINT_CAPACITY_EXCEEDED");
      const nextGeneration = existing.generation + 1;
      if (nextGeneration > Number.MAX_SAFE_INTEGER) invalid("INTEGRITY_FAILURE");
      const nextPhase = evidenceWindowAction === "open"
        ? (relevantChildren.length > 0 ? "requested" : "children-resolved")
        : evidenceWindowAction === "seal"
          ? existing.phase
          : existing.phase;
      const clearFrozenGroup = evidenceWindowAction !== "unchanged";
      const priorRootState = this.#sessionEndWorkflows.priorRootState(existing);
      const status = sessionEndGenerationStatusV2({
        current: existing,
        priorRootState,
        workflowGeneration: nextGeneration,
        triggeringEventPosition: authority.nextGlobalPosition(),
        phase: nextPhase,
        evidenceWindowState: evidenceWindowAction === "open"
          ? "open"
          : evidenceWindowAction === "seal"
            ? "sealed"
            : existing.evidenceWindowState!,
        materializationRequired: effectivePolicy.requireMaterialization,
        clearFrozenGroup,
      });
      const eventPosition = BigInt(status.triggeringEventPosition);
      if (eventPosition <= aggregate.eventPosition || eventPosition > SQLITE_INT64_MAX) {
        invalid("INTEGRITY_FAILURE");
      }
      const amendmentPayload = {
        workflowId,
        previousWorkflowGeneration: existing.generation,
        workflowGeneration: nextGeneration,
        preTransitionCheckpointId: checkpoint.checkpointId,
        evidenceWindowAction,
        effectiveState,
      } as unknown as JsonValue;
      const materializationQueue = this.#materializationQueue;
      let preparedMaterialization: PreparedMaterializationQueueV1 | undefined;
      if (materializationQueue !== undefined) {
        preparedMaterialization = materializationQueue.prepare({
          context,
          sessionId: current.sessionId as SessionId,
          artifactKind: "compatibility-session-log",
          triggeringEventIndex: 0,
          expectedTriggerPosition: eventPosition,
          triggeringEventSchemaVersion: 3,
          triggeringOccurredAt: now.timestamp,
          triggeringEventPayload: amendmentPayload,
          origin: {
            kind: "workflow",
            workflowId,
            workflowGeneration: nextGeneration,
          },
          triggeringEventType: "SessionEndAmended",
        });
      }
      const authorizationRecord: PersistedLifecycleAuthorizationRecord = Object.freeze({
        ...replayExpectation,
        proof: Object.freeze(verifiedProof),
      });
      return {
        append: {
          context,
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          commandType: command.commandType,
          correlationId: aggregate.correlationId,
          agentId: command.agentId,
          expectedStreamVersion: aggregate.streamVersion,
          streamId: current.streamId,
          streamType: "session",
          events: [{
            eventType: "SessionEndAmended",
            eventSchemaVersion: 3,
            occurredAt: now.timestamp,
            visibilityScope: "session",
            sessionId: current.sessionId,
            confidence: "high",
            verificationStatus: "verified",
            payload: amendmentPayload,
            sourceRefs: [],
            evidenceRefs: [],
            evidenceDigests: [],
          }],
          outbox: preparedMaterialization === undefined
            ? []
            : [preparedMaterialization.pendingOutbox],
          publicResponse: status,
        },
        authorizationRecord,
        freshCapabilityGeneration: generation,
        beforeAppend: (planned) => {
          if (planned.events.length !== 1 || planned.events[0]?.globalPosition !== eventPosition) {
            invalid("INTEGRITY_FAILURE");
          }
          if (preparedMaterialization !== undefined) {
            const plannedTrigger = planned.events[0];
            if (plannedTrigger === undefined) invalid("INTEGRITY_FAILURE");
            materializationQueue?.assertPlanned(preparedMaterialization, plannedTrigger);
          }
        },
        afterAppend: (committed) => {
          if (committed.events.length !== 1 || committed.events[0]?.globalPosition !== eventPosition) {
            invalid("INTEGRITY_FAILURE");
          }
          this.#sessionEndWorkflows.amendGeneration({
            projectId: current.projectId,
            workflowId,
            previousWorkflowGeneration: existing.generation,
            workflowGeneration: nextGeneration,
            rootCommandId: command.commandId,
            sessionId: current.sessionId,
            triggeringEventPosition: eventPosition,
            expectedAuthorityCommitment: current.authorityCommitment,
            phase: nextPhase,
            resultJson: canonicalJson(status),
            evidenceWindowState: status.evidenceWindow.evidenceWindowState,
            clearFrozenGroup,
            now: now.timestamp,
          });
          if (preparedMaterialization !== undefined) {
            const committedTrigger = committed.events[0];
            if (committedTrigger === undefined) invalid("INTEGRITY_FAILURE");
            materializationQueue?.assertCommitted(preparedMaterialization, committedTrigger);
          }
        },
      };
    });
    const authority = this.#authority.get(
      this.#connection,
      context.binding.projectId,
      execution.authorizationRecord.targetSessionId,
    );
    if (authority === null || authority.ownerGeneration === null) invalid("INTEGRITY_FAILURE");
    return Object.freeze({
      kind: "success",
      publicResult: execution.publicResult,
      authorityMaterial: workerMaterial(
        this.#capabilities,
        context,
        authority,
        authority.ownerGeneration.toString(),
        execution.authorizationRecord.target,
      ),
    });
  }

  cancelSessionEnd(
    context: ProjectContext,
    input: PreparedLifecycleWorkerCommand<CancelSessionEndCommandV2>,
  ): WorkerLifecycleResult<SessionEndStatusV2> {
    const decoded = decodeLifecycleSemanticCommandDraft(input.command);
    if (decoded.commandType !== "cancel-session-end") invalid();
    const command = decoded;
    assertSemanticCommandAuthorization(command, input.authorization);
    validateContext(context, command);
    if (
      input.authorization.kind !== "protected"
      || input.authorization.proof === null
      || input.authorization.approval !== null
      || input.authorization.childBindingGrant !== null
      || input.authorization.authoritySessionId !== command.sessionId
      || input.authorization.targetSessionId !== command.sessionId
    ) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
    if (!LOWER_HASH.test(input.candidateIntentHash)) {
      throw new LifecycleError("IDEMPOTENCY_CONFLICT");
    }
    const proof = input.authorization.proof;
    const proofBytes = Buffer.from(proof.proofFingerprint, "hex");
    let proofDigest: string;
    try {
      if (proofBytes.length !== 32) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
      proofDigest = capabilityProofDigest(proofBytes);
    } finally {
      proofBytes.fill(0);
    }
    const principal = Object.freeze({
      actorRole: "primary" as const,
      clientInstanceId: context.binding.clientInstanceId,
    });
    const replayExpectation: Extract<LifecycleReplayExpectation, { kind: "protected" }> = Object.freeze({
      kind: "protected",
      proof: Object.freeze({
        version: 1,
        nonce: proof.proofNonce,
        digest: proofDigest,
      }),
      approval: null,
      authorizationSessionId: command.sessionId,
      targetSessionId: command.sessionId,
      presenting: principal,
      target: principal,
    });
    const execution = this.#store.execute<SessionEndStatusV2>({
      context,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      commandType: command.commandType,
      candidateIntentHash: input.candidateIntentHash,
      authoritativeIntentHash: input.candidateIntentHash,
      semanticCommand: command,
      capabilityKind: "root-session-handle",
      capabilityGeneration: null,
      capabilityGenerationResolution: "fresh-commit",
      replayExpectation,
    }, (transaction) => {
      this.#integrity.assertQuickHealthy(context);
      const authority = rootOperations(transaction);
      const leases = leaseOperations(transaction);
      const now = exactNow(this.#clock);
      const observed = authority.get(context.binding.projectId, command.sessionId);
      if (observed === null) throw new LifecycleError("SESSION_NOT_FOUND");
      const current = Object.freeze({ ...observed }) as SessionAuthorityRecord;
      if (
        current.sessionKind !== "root"
        || current.parentSessionId !== null
        || current.ownerGeneration === null
        || current.terminalEventPosition !== null
        || current.semanticState !== "ending"
        || current.rootHandleClientInstanceId !== context.binding.clientInstanceId
      ) throw new LifecycleError("SESSION_STATE_CONFLICT");
      const aggregate = authority.requireFoldMatch(current);
      if (
        aggregate.kind !== "root"
        || aggregate.state !== "ending"
        || aggregate.terminalEventPosition !== null
        || BigInt(command.expectedStreamVersion) !== aggregate.streamVersion
      ) throw new LifecycleError("SESSION_STATE_CONFLICT");
      const currentLease = leases.current(context.binding.projectId, current.sessionId);
      if (
        currentLease === null
        || currentLease.ownerGeneration !== current.ownerGeneration
        || currentLease.ownerClientInstanceId !== context.binding.clientInstanceId
      ) throw new LifecycleError("SESSION_HANDLE_STALE");
      const generation = current.ownerGeneration.toString();
      const assertions = {
        authorizationKind: "protected" as const,
        authorizationSessionId: command.sessionId,
        targetSessionId: command.sessionId,
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        capabilityKind: "root-session-handle" as const,
        capabilityGeneration: generation,
        presentingActorRole: "primary" as const,
        presentingClientInstanceId: context.binding.clientInstanceId,
        targetActorRole: "primary" as const,
        targetClientInstanceId: context.binding.clientInstanceId,
        internalWorkflowId: null,
        internalWorkflowGeneration: null,
        internalPlannedWorkId: null,
      };
      const authoritative = buildLifecycleIntentWitness(command, assertions);
      if (authoritative.intentHash !== input.candidateIntentHash) {
        throw new LifecycleError("IDEMPOTENCY_CONFLICT");
      }
      const handleMaterial = materialFromAuthority(context, current).find(
        (material) => material.claims.kind === "root-session-handle",
      );
      if (handleMaterial === undefined) invalid("INTEGRITY_FAILURE");
      const proofTarget: SemanticCommandProofTargetV1 = {
        proofVersion: 1,
        target: "semantic-command",
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        authoritySessionId: command.sessionId,
        targetSessionId: command.sessionId,
        presentingActorRole: "primary",
        presentingClientInstanceId: context.binding.clientInstanceId,
        targetActorRole: "primary",
        targetClientInstanceId: context.binding.clientInstanceId,
        capabilityKind: "root-session-handle",
        capabilityGeneration: generation,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        intentHash: authoritative.intentHash,
        proofNonce: proof.proofNonce,
      };
      const verifiedProof = this.#capabilities.verifyProof(handleMaterial, proofTarget, proof);
      if (verifiedProof.digest !== proofDigest) invalid("INTEGRITY_FAILURE");
      const workflowId = sessionEndWorkflowId(current.sessionId as SessionId);
      if (command.workflowId !== workflowId) throw new LifecycleError("SESSION_STATE_CONFLICT");
      const existing = this.#sessionEndWorkflows.read(context.binding.projectId, workflowId);
      if (
        existing === null
        || existing.sessionId !== current.sessionId
        || existing.phase === "cancelled"
        || existing.phase === "abandoned"
        || existing.phase === "completed"
        || aggregate.endWorkflowId !== workflowId
        || aggregate.endWorkflowGeneration !== existing.generation
      ) throw new LifecycleError("SESSION_END_INCOMPLETE");
      const relevantChildren = riskyTransitionChildren(authority, current);
      const checkpoint = requireRiskyTransitionCheckpointV1({
        authority: current,
        aggregate,
        checkpoint: authority.latestCheckpoint(current),
        explicitCheckpointId: command.preTransitionCheckpointId,
        allowTrailingRootEvents: true,
        relevantChildren,
      });
      const currentSourceState = this.#resumeSourceState.captureCurrent(context);
      if (canonicalJson(currentSourceState) !== canonicalJson(checkpoint.sourceState)) {
        throw new LifecycleError("SESSION_SOURCE_STATE_CONFLICT");
      }
      const priorRootState = this.#sessionEndWorkflows.priorRootState(existing);
      const eventPosition = authority.nextGlobalPosition();
      if (eventPosition <= aggregate.eventPosition || eventPosition > SQLITE_INT64_MAX) {
        invalid("INTEGRITY_FAILURE");
      }
      const status = sessionEndGenerationStatusV2({
        current: existing,
        priorRootState,
        workflowGeneration: existing.generation + 1,
        triggeringEventPosition: eventPosition,
        phase: "cancelled",
        evidenceWindowState: "sealed",
        materializationRequired: existing.resultJson === null
          ? false
          : (() => {
              const parsed = JSON.parse(existing.resultJson) as Record<string, unknown>;
              const status = typeof parsed.status === "object" && parsed.status !== null
                ? parsed.status as Record<string, unknown>
                : parsed;
              return status.materializationRequired === true;
            })(),
        clearFrozenGroup: true,
      });
      const nextAuthority = Object.freeze({
        ...current,
        semanticState: priorRootState,
        updatedAt: now.timestamp,
      });
      const cancellationPayload = {
        cancellationVersion: 1,
        workflowId,
        previousWorkflowGeneration: existing.generation,
        workflowGeneration: existing.generation + 1,
        restoredState: priorRootState,
        preTransitionCheckpointId: command.preTransitionCheckpointId,
      } as unknown as JsonValue;
      const materializationQueue = this.#materializationQueue;
      let preparedMaterialization: PreparedMaterializationQueueV1 | undefined;
      if (materializationQueue !== undefined) {
        preparedMaterialization = materializationQueue.prepare({
          context,
          sessionId: current.sessionId as SessionId,
          artifactKind: "compatibility-session-log",
          triggeringEventIndex: 0,
          expectedTriggerPosition: eventPosition,
          triggeringEventSchemaVersion: 3,
          triggeringOccurredAt: now.timestamp,
          triggeringEventPayload: cancellationPayload,
          origin: {
            kind: "workflow",
            workflowId,
            workflowGeneration: existing.generation + 1,
          },
          triggeringEventType: "SessionEndCancelled",
        });
      }
      const authorizationRecord: PersistedLifecycleAuthorizationRecord = Object.freeze({
        ...replayExpectation,
        proof: Object.freeze(verifiedProof),
      });
      return {
        append: {
          context,
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          commandType: command.commandType,
          correlationId: aggregate.correlationId,
          agentId: command.agentId,
          expectedStreamVersion: aggregate.streamVersion,
          streamId: current.streamId,
          streamType: "session",
          events: [{
            eventType: "SessionEndCancelled",
            eventSchemaVersion: 3,
            occurredAt: now.timestamp,
            visibilityScope: "session",
            sessionId: current.sessionId,
            confidence: "high",
            verificationStatus: "verified",
            payload: cancellationPayload,
            sourceRefs: [],
            evidenceRefs: [],
            evidenceDigests: [],
          }],
          outbox: preparedMaterialization === undefined
            ? []
            : [preparedMaterialization.pendingOutbox],
          publicResponse: status,
        },
        authorizationRecord,
        freshCapabilityGeneration: generation,
        beforeAppend: (planned) => {
          if (planned.events.length !== 1 || planned.events[0]?.globalPosition !== eventPosition) {
            invalid("INTEGRITY_FAILURE");
          }
          if (preparedMaterialization !== undefined) {
            const plannedTrigger = planned.events[0];
            if (plannedTrigger === undefined) invalid("INTEGRITY_FAILURE");
            materializationQueue?.assertPlanned(preparedMaterialization, plannedTrigger);
          }
        },
        afterAppend: (committed, currentTransaction) => {
          if (committed.events.length !== 1 || committed.events[0]?.globalPosition !== eventPosition) {
            invalid("INTEGRITY_FAILURE");
          }
          const currentAuthority = rootOperations(currentTransaction);
          const currentLeases = leaseOperations(currentTransaction);
          if (!currentAuthority.compareAndSwap({
            projectId: current.projectId,
            sessionId: current.sessionId,
            expectedState: "ending",
            expectedOwnerGeneration: current.ownerGeneration!,
            expectedChildCapabilityGeneration: null,
            expectedAuthorityCommitment: current.authorityCommitment,
            next: authorityMutation(nextAuthority),
          })) throw new LifecycleError("SESSION_HANDLE_STALE");
          this.#sessionEndWorkflows.cancelGeneration({
            projectId: current.projectId,
            workflowId,
            previousWorkflowGeneration: existing.generation,
            workflowGeneration: existing.generation + 1,
            rootCommandId: command.commandId,
            sessionId: current.sessionId,
            triggeringEventPosition: eventPosition,
            expectedAuthorityCommitment: current.authorityCommitment,
            restoredState: priorRootState,
            resultJson: canonicalJson(status),
            now: now.timestamp,
          });
          currentLeases.renewCurrent({
            projectId: current.projectId,
            sessionId: current.sessionId,
            ownerGeneration: current.ownerGeneration!,
            ownerClientInstanceId: context.binding.clientInstanceId,
            observedNowMs: now.milliseconds,
            leaseDurationMs: OWNER_LEASE_DURATION_MS,
          });
          if (preparedMaterialization !== undefined) {
            const committedTrigger = committed.events[0];
            if (committedTrigger === undefined) invalid("INTEGRITY_FAILURE");
            materializationQueue?.assertCommitted(preparedMaterialization, committedTrigger);
          }
        },
      };
    });
    const authority = this.#authority.get(
      this.#connection,
      context.binding.projectId,
      execution.authorizationRecord.targetSessionId,
    );
    if (authority === null || authority.ownerGeneration === null) invalid("INTEGRITY_FAILURE");
    return Object.freeze({
      kind: "success",
      publicResult: execution.publicResult,
      authorityMaterial: workerMaterial(
        this.#capabilities,
        context,
        authority,
        authority.ownerGeneration.toString(),
        execution.authorizationRecord.target,
      ),
    });
  }

  abandonSession(
    context: ProjectContext,
    input: PreparedLifecycleWorkerCommand<AbandonSessionCommandV2>,
  ): WorkerLifecycleResult<SessionEndStatusV2> {
    const decoded = decodeLifecycleSemanticCommandDraft(input.command);
    if (decoded.commandType !== "abandon-session") invalid();
    const command = decoded;
    assertSemanticCommandAuthorization(command, input.authorization);
    validateContext(context, command);
    if (
      input.authorization.kind !== "protected"
      || input.authorization.proof === null
      || input.authorization.approval === null
      || input.authorization.childBindingGrant !== null
      || input.authorization.authoritySessionId !== command.sessionId
      || input.authorization.targetSessionId !== command.sessionId
    ) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
    if (!LOWER_HASH.test(input.candidateIntentHash)) {
      throw new LifecycleError("IDEMPOTENCY_CONFLICT");
    }
    const proof = input.authorization.proof;
    const approval = input.authorization.approval;
    const proofBytes = Buffer.from(proof.proofFingerprint, "hex");
    let proofDigest: string;
    try {
      if (proofBytes.length !== 32) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
      proofDigest = capabilityProofDigest(proofBytes);
    } finally {
      proofBytes.fill(0);
    }
    const replayExpectation = abandonmentReplayExpectation(
      context,
      command,
      approval,
      { nonce: proof.proofNonce, digest: proofDigest },
      input.candidateIntentHash,
    );
    const execution = this.#store.execute<SessionEndStatusV2>({
      context,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      commandType: command.commandType,
      candidateIntentHash: input.candidateIntentHash,
      authoritativeIntentHash: input.candidateIntentHash,
      semanticCommand: command,
      capabilityKind: "root-session-handle",
      capabilityGeneration: null,
      capabilityGenerationResolution: "fresh-commit",
      replayExpectation,
    }, (transaction) => {
      const now = exactNow(this.#clock);
      const issuedAtMs = BigInt(Date.parse(approval.issuedAt));
      const expiresAtMs = BigInt(Date.parse(approval.expiresAt));
      if (now.milliseconds < issuedAtMs) {
        throw new LifecycleError("LIFECYCLE_APPROVAL_INVALID");
      }
      if (now.milliseconds >= expiresAtMs) {
        throw new LifecycleError("LIFECYCLE_APPROVAL_EXPIRED");
      }
      this.#integrity.assertQuickHealthy(context);
      const authority = rootOperations(transaction);
      const leases = leaseOperations(transaction);
      const observed = authority.get(context.binding.projectId, command.sessionId);
      if (observed === null) throw new LifecycleError("SESSION_NOT_FOUND");
      const current = Object.freeze({ ...observed }) as SessionAuthorityRecord;
      if (
        current.sessionKind !== "root"
        || current.parentSessionId !== null
        || current.ownerGeneration === null
        || current.terminalEventPosition !== null
        || (current.semanticState !== "active"
          && current.semanticState !== "suspended"
          && current.semanticState !== "ending")
        || current.rootHandleClientInstanceId !== context.binding.clientInstanceId
      ) throw new LifecycleError("SESSION_STATE_CONFLICT");
      const aggregate = authority.requireFoldMatch(current);
      if (
        aggregate.kind !== "root"
        || aggregate.state !== current.semanticState
        || BigInt(command.expectedStreamVersion) !== aggregate.streamVersion
      ) throw new LifecycleError("SESSION_STATE_CONFLICT");
      if (approval.expectedOwnerGeneration !== current.ownerGeneration.toString()
        || approval.targetClientInstanceId !== current.rootHandleClientInstanceId) {
        throw new LifecycleError("SESSION_HANDLE_STALE");
      }
      const currentLease = leases.current(context.binding.projectId, current.sessionId);
      if (
        currentLease === null
        || currentLease.ownerGeneration !== current.ownerGeneration
        || currentLease.ownerClientInstanceId !== context.binding.clientInstanceId
      ) throw new LifecycleError("SESSION_HANDLE_STALE");
      const generation = current.ownerGeneration.toString();
      const assertions = {
        authorizationKind: "protected" as const,
        authorizationSessionId: command.sessionId,
        targetSessionId: command.sessionId,
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        capabilityKind: "root-session-handle" as const,
        capabilityGeneration: generation,
        presentingActorRole: "primary" as const,
        presentingClientInstanceId: context.binding.clientInstanceId,
        targetActorRole: "primary" as const,
        targetClientInstanceId: context.binding.clientInstanceId,
        internalWorkflowId: null,
        internalWorkflowGeneration: null,
        internalPlannedWorkId: null,
      };
      const authoritative = buildLifecycleIntentWitness(command, assertions);
      if (authoritative.intentHash !== input.candidateIntentHash) {
        throw new LifecycleError("IDEMPOTENCY_CONFLICT");
      }
      const handleMaterial = materialFromAuthority(context, current).find(
        (material) => material.claims.kind === "root-session-handle",
      );
      if (handleMaterial === undefined) invalid("INTEGRITY_FAILURE");
      const proofTarget: SemanticCommandProofTargetV1 = {
        proofVersion: 1,
        target: "semantic-command",
        projectId: context.binding.projectId,
        vaultId: context.binding.vaultId,
        storeId: context.binding.storeId,
        workspaceId: context.binding.workspaceId,
        clientNamespace: context.binding.clientNamespace,
        authoritySessionId: command.sessionId,
        targetSessionId: command.sessionId,
        presentingActorRole: "primary",
        presentingClientInstanceId: context.binding.clientInstanceId,
        targetActorRole: "primary",
        targetClientInstanceId: context.binding.clientInstanceId,
        capabilityKind: "root-session-handle",
        capabilityGeneration: generation,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        intentHash: authoritative.intentHash,
        proofNonce: proof.proofNonce,
      };
      const verifiedProof = this.#capabilities.verifyProof(handleMaterial, proofTarget, proof);
      if (verifiedProof.digest !== proofDigest) invalid("INTEGRITY_FAILURE");

      const relevantChildren = riskyTransitionChildren(authority, current);
      const checkpoint = requireRiskyTransitionCheckpointV1({
        authority: current,
        aggregate,
        checkpoint: authority.latestCheckpoint(current),
        explicitCheckpointId: command.preTransitionCheckpointId,
        allowTrailingRootEvents: current.semanticState === "ending",
        relevantChildren,
      });
      const currentSourceState = this.#resumeSourceState.captureCurrent(context);
      if (canonicalJson(currentSourceState) !== canonicalJson(checkpoint.sourceState)) {
        throw new LifecycleError("SESSION_SOURCE_STATE_CONFLICT");
      }

      const workflowId = sessionEndWorkflowId(current.sessionId as SessionId);
      const existing = this.#sessionEndWorkflows.read(context.binding.projectId, workflowId);
      const inEndingWorkflow = current.semanticState === "ending";
      if (inEndingWorkflow) {
        if (
          existing === null
          || existing.sessionId !== current.sessionId
          || existing.phase === "cancelled"
          || existing.phase === "abandoned"
          || existing.phase === "completed"
          || aggregate.endWorkflowId !== workflowId
          || aggregate.endWorkflowGeneration !== existing.generation
        ) throw new LifecycleError("SESSION_END_INCOMPLETE");
      } else if (existing !== null
        && existing.sessionId === current.sessionId
        && existing.phase !== "cancelled"
        && existing.phase !== "abandoned"
        && existing.phase !== "completed") {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }

      const eventPosition = authority.nextGlobalPosition();
      if (eventPosition <= aggregate.eventPosition || eventPosition > SQLITE_INT64_MAX) {
        invalid("INTEGRITY_FAILURE");
      }
      const occurredAt = now.timestamp;
      const provisional: SessionAuthorityRecord = Object.freeze({
        ...current,
        semanticState: "abandoned" as const,
        authorityEventPosition: eventPosition,
        terminalEventPosition: eventPosition,
        terminalEventType: "SessionAbandoned" as const,
        terminalAt: occurredAt,
        updatedAt: occurredAt,
      });
      const nextCommitment = authorityCommitment(committedAuthority(provisional));
      const nextAuthority = authorityMutation(Object.freeze({
        ...provisional,
        authorityCommitment: nextCommitment,
      }));
      const workflowGeneration = inEndingWorkflow && existing !== null
        ? existing.generation
        : null;
      const payload = Object.freeze({
        workflowId: inEndingWorkflow ? workflowId : null,
        workflowGeneration,
        approvalId: approval.approvalId,
        preTransitionCheckpointId: command.preTransitionCheckpointId,
        reasonCode: command.reasonCode,
        authorityCommitment: nextCommitment,
      }) as unknown as JsonValue;
      const status: SessionEndStatusV2 = inEndingWorkflow && existing !== null
        ? sessionEndGenerationStatusV2({
            current: existing,
            priorRootState: existing.state === "suspended" ? "suspended" : "active",
            workflowGeneration: existing.generation,
            triggeringEventPosition: eventPosition,
            phase: "abandoned",
            evidenceWindowState: "sealed",
            materializationRequired: false,
            clearFrozenGroup: true,
          })
        : Object.freeze({
            resultVersion: 2,
            sessionId: current.sessionId as SessionId,
            workflowId,
            workflowGeneration: 1,
            priorRootState: current.semanticState === "suspended" ? "suspended" : "active",
            phase: "abandoned" as const,
            triggeringEventPosition: eventPosition.toString(),
            finalCheckpointId: null,
            finalCheckpointEventPosition: null,
            evidenceWindow: Object.freeze({
              evidenceWindowState: "sealed" as const,
              evidenceFrozenCheckpointEventPosition: null,
              evidenceFrozenGeneration: null,
            }),
            validationPlansReady: false,
            qualityScore: null,
            safeFailureCode: null,
            materializationRequired: false,
          });
      const materializationQueue = this.#materializationQueue;
      if (materializationQueue === undefined) {
        throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
      }
      const preparedMaterialization = inEndingWorkflow && existing !== null
        ? materializationQueue.prepare({
            context,
            sessionId: current.sessionId as SessionId,
            artifactKind: "compatibility-session-log",
            triggeringEventIndex: 0,
            expectedTriggerPosition: eventPosition,
            triggeringEventSchemaVersion: 1,
            triggeringOccurredAt: occurredAt,
            triggeringEventPayload: payload,
            origin: {
              kind: "workflow" as const,
              workflowId,
              workflowGeneration: existing.generation,
            },
            triggeringEventType: "SessionAbandoned" as const,
          })
        : materializationQueue.prepare({
            context,
            sessionId: current.sessionId as SessionId,
            artifactKind: "compatibility-session-log",
            triggeringEventIndex: 0,
            expectedTriggerPosition: eventPosition,
            triggeringEventSchemaVersion: 1,
            triggeringOccurredAt: occurredAt,
            triggeringEventPayload: payload,
            origin: {
              kind: "terminal-event" as const,
              workflowId: null,
              workflowGeneration: null,
            },
            triggeringEventType: "SessionAbandoned" as const,
          });
      const authorizationRecord: PersistedLifecycleAuthorizationRecord = Object.freeze({
        ...replayExpectation,
        proof: Object.freeze(verifiedProof),
      });
      return {
        append: {
          context,
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          commandType: command.commandType,
          correlationId: aggregate.correlationId,
          agentId: command.agentId,
          expectedStreamVersion: aggregate.streamVersion,
          streamId: current.streamId,
          streamType: "session",
          events: [{
            eventType: "SessionAbandoned",
            eventSchemaVersion: 1,
            occurredAt,
            visibilityScope: "session",
            sessionId: current.sessionId,
            confidence: "high",
            verificationStatus: "verified",
            payload,
            sourceRefs: [],
            evidenceRefs: [],
            evidenceDigests: [],
          }],
          outbox: [preparedMaterialization.pendingOutbox],
          publicResponse: status,
        },
        authorizationRecord,
        freshCapabilityGeneration: generation,
        beforeAppend: (planned, currentTransaction) => {
          const trigger = planned.events[0];
          if (planned.events.length !== 1
            || trigger === undefined
            || trigger.globalPosition !== eventPosition) invalid("INTEGRITY_FAILURE");
          materializationQueue.assertPlanned(preparedMaterialization, trigger);
          const currentAuthority = rootOperations(currentTransaction);
          const currentLeases = leaseOperations(currentTransaction);
          currentLeases.releaseCurrent({
            projectId: current.projectId,
            sessionId: current.sessionId,
            ownerGeneration: current.ownerGeneration!,
            ownerClientInstanceId: currentLease.ownerClientInstanceId,
            expectedLastObservedAtMs: currentLease.lastObservedAtMs,
            expectedExpiresAtMs: currentLease.expiresAtMs,
            observedNowMs: now.milliseconds,
          });
          if (!currentAuthority.compareAndSwap({
            projectId: current.projectId,
            sessionId: current.sessionId,
            expectedState: current.semanticState as RootSessionState,
            expectedOwnerGeneration: current.ownerGeneration!,
            expectedChildCapabilityGeneration: null,
            expectedAuthorityCommitment: current.authorityCommitment,
            next: nextAuthority,
          })) throw new LifecycleError("SESSION_HANDLE_STALE");
        },
        afterAppend: (committed, currentTransaction) => {
          const abandonedEvent = committed.events[0];
          if (committed.events.length !== 1
            || abandonedEvent === undefined
            || abandonedEvent.globalPosition !== eventPosition
            || abandonedEvent.eventType !== "SessionAbandoned") {
            invalid("INTEGRITY_FAILURE");
          }
          approvalOperations(currentTransaction).consume({
            approvalId: approval.approvalId,
            nonceDigest: approval.nonceDigest,
            projectId: current.projectId,
            sessionId: current.sessionId,
            action: "abandon-root",
            commandId: command.commandId,
            targetActorRole: "primary",
            targetClientInstanceId: approval.targetClientInstanceId,
            redactedApprovalReference: approval.redactedApprovalReference,
            consumedEventPosition: abandonedEvent.globalPosition,
            consumedAtMs: now.milliseconds,
          });
          if (inEndingWorkflow && existing !== null) {
            this.#sessionEndWorkflows.abandonGeneration({
              projectId: current.projectId,
              workflowId,
              workflowGeneration: existing.generation,
              rootCommandId: command.commandId,
              sessionId: current.sessionId,
              triggeringEventPosition: abandonedEvent.globalPosition,
              expectedAuthorityCommitment: nextCommitment,
              resultJson: canonicalJson(status),
              now: occurredAt,
            });
          }
          materializationQueue.assertCommitted(preparedMaterialization, abandonedEvent);
        },
      };
    });
    const authority = this.#authority.get(
      this.#connection,
      context.binding.projectId,
      execution.authorizationRecord.targetSessionId,
    );
    if (authority === null || authority.ownerGeneration === null) invalid("INTEGRITY_FAILURE");
    return Object.freeze({
      kind: "success",
      publicResult: execution.publicResult,
      authorityMaterial: workerMaterial(
        this.#capabilities,
        context,
        authority,
        authority.ownerGeneration.toString(),
        execution.authorizationRecord.target,
      ),
    });
  }
}
