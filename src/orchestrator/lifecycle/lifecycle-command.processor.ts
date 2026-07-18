import { createHash } from "node:crypto";
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
} from "./contracts/commands.js";
import {
  assertSemanticCommandAuthorization,
  decodeLifecycleSemanticCommandDraft,
} from "./contracts/commands.js";
import type { RootSessionState } from "./contracts/identifiers.js";
import {
  decodeCheckpointDraftV1,
  decodeCheckpointV1,
  type CheckpointV1,
  type SourceStateFingerprintV1,
} from "./contracts/checkpoint.js";
import {
  encodeSessionAmbiguitySummaries,
  LifecycleError,
  MAX_SESSION_AMBIGUITY_SUMMARIES,
} from "./errors.js";
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
import type { LifecycleApprovalRepository } from "../storage/lifecycle-approval.repository.js";
import type { SessionAuthorityRepository } from "../storage/session-authority.repository.js";
import type { SessionLeaseRepository } from "../storage/session-lease.repository.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { isPrimarySqliteBusy } from "../storage/event-append-transaction.js";
import { MAX_CANONICAL_TIMESTAMP_MS } from "../runtime/clock.js";
import {
  requireRiskyTransitionCheckpointV1,
  requireTrustedCheckpointDraftV1,
} from "./checkpoint.service.js";
import type {
  SourceStateProvider,
  SourceStateScopeResolver,
} from "./source-state.provider.js";

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
  latestCheckpoint(authority: SessionAuthorityRecord): CheckpointV1 | null;
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
  command: RootStartCommandV2 | RootResumeCommandV2 | RootSuspendCommandV2,
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
        const pageCheckpoints = new Map<string, CheckpointV1>();
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
    input: PreparedLifecycleWorkerCommand<RootSuspendCommandV2>,
  ): WorkerLifecycleResult<RootSessionPublicResultV2> {
    const decoded = decodeLifecycleSemanticCommandDraft(input.command);
    if (decoded.commandType !== "root-suspend") invalid();
    assertSemanticCommandAuthorization(decoded, input.authorization);
    validateContext(context, decoded);
    if (
      input.authorization.kind !== "protected"
      || input.authorization.proof === null
      || input.authorization.approval !== null
      || input.authorization.childBindingGrant !== null
      || input.authorization.authoritySessionId !== decoded.sessionId
      || input.authorization.targetSessionId !== decoded.sessionId
    ) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
    const checkpointDraft = decodeCheckpointDraftV1(decoded.checkpoint);
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
      const childSummaries = authority.listNonterminalChildren(
        context.binding.projectId,
        current.sessionId,
      ).map((childView) => {
        const child = Object.freeze({ ...childView }) as SessionAuthorityRecord;
        const childAggregate = authority.requireFoldMatch(child);
        if (childAggregate.kind !== "child" || child.parentSessionId !== current.sessionId) {
          invalid("INTEGRITY_FAILURE");
        }
        if (childAggregate.eventPosition > baseEventPosition) invalid("INTEGRITY_FAILURE");
        return Object.freeze({
          childSessionId: child.sessionId,
          state: childAggregate.state,
          lastEventPosition: childAggregate.eventPosition.toString(),
          streamVersion: childAggregate.streamVersion.toString(),
          latestCheckpointId: childAggregate.latestCheckpointId,
        });
      }).sort((left, right) => compareBinaryText(left.childSessionId, right.childSessionId));
      const sourceStateScope = this.#checkpointSourceStateScopes.resolve(this.#connection, context);
      const sourceState = this.#checkpointSourceState.captureForCheckpoint(context, sourceStateScope);
      if (typeof sourceState === "object" && sourceState !== null && "then" in sourceState) {
        invalid("INTEGRITY_FAILURE");
      }
      const expectedCheckpointBranch = context.workspace.kind === "git" ? context.workspace.branchRef : null;
      if (sourceState.workspaceId !== context.workspace.workspaceId
        || sourceState.branchRef !== expectedCheckpointBranch) invalid("INTEGRITY_FAILURE");
      requireTrustedCheckpointDraftV1(context, checkpointDraft, sourceState);
      const checkpoint = decodeCheckpointV1({
        ...checkpointDraft,
        checkpointId: this.#ids.uuid(),
        sessionId: current.sessionId,
        parentSessionId: null,
        baseEventPosition: baseEventPosition.toString(),
        checkpointEventPosition: checkpointPosition.toString(),
        createdAt: now.timestamp,
        creatorAgentId: decoded.agentId,
        creatorClientInstanceId: context.binding.clientInstanceId,
        sourceState,
        childSummaries,
        evidenceCoverage: {
          captureMode: "coverage-only",
          contentRetained: false,
          highestContiguousOrdinal: null,
          missingIntervals: [],
        },
      }) as CheckpointV1;
      const checkpointFingerprint = createHash("sha256")
        .update("project-memory/checkpoint/v1\n", "utf8")
        .update(canonicalJson(checkpoint as unknown as JsonValue), "utf8")
        .digest("hex");
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
          events: [{
            eventType: "SessionCheckpointRecorded",
            eventSchemaVersion: 1,
            occurredAt: now.timestamp,
            visibilityScope: "session",
            sessionId: current.sessionId,
            confidence: "high",
            verificationStatus: "verified",
            payload: {
              checkpoint: checkpoint as unknown as JsonValue,
              baseEventPosition: baseEventPosition.toString(),
              checkpointEventPosition: checkpointPosition.toString(),
            } as JsonValue,
            sourceRefs: [],
            evidenceRefs: [],
            evidenceDigests: [],
          }, {
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
}
