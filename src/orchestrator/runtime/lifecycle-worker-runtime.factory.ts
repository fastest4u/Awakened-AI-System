import type {
  JsonValue,
  LifecycleReplayExpectation,
  PersistedLifecycleAuthorizationRecord,
} from "../contracts/event.js";
import type { BranchScopeId, ProjectContext } from "../identity/contracts.js";
import type { CapabilityKeyProvider } from "../lifecycle/authority/capability-key-provider.js";
import {
  capabilityProofDigest,
  type SemanticCommandProofTargetV1,
} from "../lifecycle/authority/capability-codec.js";
import type { WorkerAuthorityMaterialResultV1, WorkerLifecycleResult } from "../lifecycle/authority/authority-material-adapter.js";
import {
  CapabilityService,
  type StoredCapabilityMaterialV1,
} from "../lifecycle/capability.service.js";
import {
  CheckpointService,
  type CheckpointRecordedResult,
  type TrustedCheckpointInvocationV1,
} from "../lifecycle/checkpoint.service.js";
import {
  ChildWorkflowService,
  type ChildWorkflowServiceOptions,
} from "../lifecycle/child-workflow.service.js";
import {
  assertSemanticCommandAuthorization,
  decodeLifecycleSemanticCommandDraft,
  type PreparedLifecycleWorkerCommand,
  type RecordCheckpointCommandV2,
  type RecordCheckpointCommandV3,
  type RecordEvidenceBatchCommandV2,
} from "../lifecycle/contracts/commands.js";
import {
  EvidenceCoverageService,
  type EvidenceCoverageRecordedResultV2,
  type TrustedEvidenceCoverageInvocationV2,
} from "../lifecycle/evidence-coverage.service.js";
import { LifecycleError } from "../lifecycle/errors.js";
import type {
  LifecycleProcessorIntegrity,
  LifecycleResumeSourceStatePort,
} from "../lifecycle/lifecycle-command.processor.js";
import { LifecycleCommandProcessor } from "../lifecycle/lifecycle-command.processor.js";
import type {
  LifecycleCommandTransaction,
} from "../lifecycle/lifecycle-command.store.js";
import { LifecycleCommandStore } from "../lifecycle/lifecycle-command.store.js";
import type {
  LifecycleOperationalRepositorySet,
} from "../lifecycle/lifecycle-operational.store.js";
import {
  createConnectionBoundLifecycleOutboxOperations,
  createConnectionBoundLifecycleMaterializationReads,
  LifecycleOperationalStore,
} from "../lifecycle/lifecycle-operational.store.js";
import { LifecycleQueryService } from "../lifecycle/lifecycle-query.service.js";
import { SessionEndChildService } from "../lifecycle/session-end-child.service.js";
import { SessionEndCoordinator } from "../lifecycle/session-end.coordinator.js";
import { LifecycleRecoveryCoordinator } from "../lifecycle/lifecycle-recovery.coordinator.js";
import { ConnectionBoundSessionEndWorkflowOperations } from "../lifecycle/session-end-workflow.service.js";
import type { PendingLifecycleOutboxV1 } from "../lifecycle/materialization-queue.port.js";
import type { StoredEvent } from "../contracts/event.js";
import { SqliteLifecycleMaterializationQueue } from "../materialization/sqlite-lifecycle-materialization-queue.js";
import { SqliteLifecycleMaterializationPlanningReads } from "../materialization/sqlite-lifecycle-materialization-planning-reads.js";
import { CompatibilityLogMaterializer } from "../materialization/compatibility-log.materializer.js";
import { LifecycleOutboxRepository } from "../storage/lifecycle-outbox.repository.js";
import {
  readPersistedValidationAttemptPlansV1,
  SessionEndWorkflowRepository,
} from "../storage/session-end.repository.js";
import { LifecycleValidationResultRepository } from "../storage/lifecycle-validation-result.repository.js";
import type {
  LifecycleEvidenceCoverageReadOperations,
  LifecycleSessionAuthorityReadOperations,
  LifecycleChildTransferReadOperations,
  LifecycleValidationPlanReadOperations,
} from "../storage/lifecycle-storage.types.js";
import type { TrustedValidationProfileRegistry } from "../lifecycle/validation-profile.registry.js";
import type { LifecycleFaultInjector } from "../lifecycle/lifecycle-faults.js";
import { buildLifecycleIntentWitness } from "../lifecycle/lifecycle-intent-witness.js";
import type {
  SourceStateProvider,
  SourceStateScopeResolver,
} from "../lifecycle/source-state.provider.js";
import type { LifecycleApprovalRepository } from "../storage/lifecycle-approval.repository.js";
import type { ChildTransferRepository } from "../storage/child-transfer.repository.js";
import type { EvidenceCoverageRepository } from "../storage/evidence-coverage.repository.js";
import type { LifecycleProjectionWriter } from "../storage/lifecycle-projection.repository.js";
import type { SessionAuthorityRecord } from "../storage/lifecycle-storage.types.js";
import type { MaintenanceFence } from "../storage/maintenance-fence.js";
import type {
  CheckpointAtEventPositionInput,
  SessionAuthorityRepository,
} from "../storage/session-authority.repository.js";
import type { SessionLeaseRepository } from "../storage/session-lease.repository.js";
import type { PersistedValidationAttemptPlansWriteV1 } from "../storage/session-end.repository.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import { BranchScopeRepository } from "../storage/branch-scope.repository.js";
import {
  EventAppendTransaction,
  NO_EVENT_STORE_FAULTS,
  SqliteEventAppendStatements,
} from "../storage/event-append-transaction.js";
import {
  ConnectionBoundLifecycleWorkerRuntime,
  type LifecycleWorkerRuntime,
  type PreparedCheckpointLifecycleHandler,
  type PreparedEvidenceLifecycleHandler,
} from "./lifecycle-worker-runtime.js";

export interface LifecycleWorkerRuntimeCreateInput {
  readonly connection: SqliteConnection;
  readonly maintenanceFence: MaintenanceFence;
  readonly keyProvider: CapabilityKeyProvider;
}

export interface LifecycleRuntimeClock {
  nowMs(): bigint;
  now(): string;
}

export interface LifecycleRuntimeIdentitySource {
  uuid(): string;
  bytes(length: number): Uint8Array;
}

export interface LifecycleRuntimeRepositoryFactories {
  authority(options?: { readonly faultInjector?: LifecycleFaultInjector }): SessionAuthorityRepository;
  leases(options?: { readonly faultInjector?: LifecycleFaultInjector }): SessionLeaseRepository;
  approvals(): LifecycleApprovalRepository;
  transfers(options?: { readonly faultInjector?: LifecycleFaultInjector }): ChildTransferRepository;
  coverage(provider: CapabilityKeyProvider): EvidenceCoverageRepository;
  projection(connection: SqliteConnection): LifecycleProjectionWriter;
}

export interface LifecycleTransactionFacadeFactory {
  command(input: {
    readonly connection: SqliteConnection;
    readonly authority: SessionAuthorityRepository;
    readonly leases: SessionLeaseRepository;
    readonly approvals: LifecycleApprovalRepository;
    readonly transfers: ChildTransferRepository;
    readonly coverage: EvidenceCoverageRepository;
  }): LifecycleCommandTransaction;
  operational(input: {
    readonly connection: SqliteConnection;
  }): LifecycleOperationalRepositorySet;
}

export interface LifecycleWorkerRuntimeFactoryOptions {
  readonly clock: LifecycleRuntimeClock;
  readonly identitySource: LifecycleRuntimeIdentitySource;
  readonly integrity: LifecycleProcessorIntegrity;
  readonly resumeSourceState: LifecycleResumeSourceStatePort;
  readonly checkpointSourceStateProvider: SourceStateProvider;
  readonly checkpointSourceStateScopeResolver: SourceStateScopeResolver;
  readonly childBindingFingerprint: ChildWorkflowServiceOptions["childBindingFingerprint"];
  readonly repositories: LifecycleRuntimeRepositoryFactories;
  readonly transactionFacades: LifecycleTransactionFacadeFactory;
  /** Optional until a deployment supplies its immutable trusted profile table. */
  readonly validationProfileRegistry?: TrustedValidationProfileRegistry;
  /** Fixture-only fault injection; production composition leaves this unset. */
  readonly faultInjector?: LifecycleFaultInjector;
  /** Fixture-only observer for exercising the fully composed session-end driver. */
  readonly onSessionEndCoordinatorCreated?: (coordinator: SessionEndCoordinator) => void;
}

export interface LifecycleWorkerRuntimeFactoryPort {
  create(input: LifecycleWorkerRuntimeCreateInput): LifecycleWorkerRuntime;
}

type RoutedPreparedCommand =
  | RecordCheckpointCommandV2
  | RecordCheckpointCommandV3
  | RecordEvidenceBatchCommandV2;

type ProtectedAuthorizationRecord = Extract<
  PersistedLifecycleAuthorizationRecord,
  { readonly kind: "protected" }
>;

interface ProtectedBoundary<C extends RoutedPreparedCommand> {
  readonly command: C;
  readonly prepared: PreparedLifecycleWorkerCommand<C>;
  readonly capabilityKind: "root-session-handle" | "child-session-handle";
  readonly replayExpectation: Extract<LifecycleReplayExpectation, { readonly kind: "protected" }>;
  readonly proofDigest: string;
}

interface VerifiedProtectedInvocation {
  readonly generation: string;
  readonly authorizationRecord: ProtectedAuthorizationRecord;
  readonly authorizationAuthority: SessionAuthorityRecord;
  readonly targetAuthority: SessionAuthorityRecord;
  readonly targetAggregate: import("../lifecycle/session-aggregate.js").SessionAggregateState;
}

interface SemanticAuthorityOperations {
  get(projectId: string, sessionId: string): SessionAuthorityRecord | null;
  requireFoldMatch(
    authority: SessionAuthorityRecord,
  ): import("../lifecycle/session-aggregate.js").SessionAggregateState;
}

function integrityFailure(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function ownDataProperty<T>(value: object, key: string): T {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    return integrityFailure();
  }
  return descriptor.value as T;
}

function ownOptionalDataProperty<T>(value: object, key: string): T | undefined {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable) return integrityFailure();
  return descriptor.value as T | undefined;
}

function ownMethod<T extends (...arguments_: never[]) => unknown>(
  value: object,
  key: string,
): T {
  const method = ownDataProperty<unknown>(value, key);
  if (typeof method !== "function") return integrityFailure();
  return method as T;
}

function semanticAuthorityOperations(
  transaction: LifecycleCommandTransaction,
): SemanticAuthorityOperations {
  if (typeof transaction !== "object" || transaction === null
    || typeof transaction.authority !== "object" || transaction.authority === null) {
    return integrityFailure();
  }
  return Object.freeze({
    get: ownMethod<SemanticAuthorityOperations["get"]>(transaction.authority, "get"),
    requireFoldMatch: ownMethod<SemanticAuthorityOperations["requireFoldMatch"]>(
      transaction.authority,
      "requireFoldMatch",
    ),
  });
}

function assertContext(context: ProjectContext, command: RoutedPreparedCommand): void {
  const binding = context?.binding;
  if (
    binding === undefined
    || (binding.actorRole !== "primary" && binding.actorRole !== "untrusted")
    || binding.projectId !== command.expectedProjectId
    || binding.vaultId !== command.expectedVaultId
    || binding.workspaceId !== command.expectedWorkspaceId
    || context.workspace !== binding.workspace
    || context.workspace.workspaceId !== binding.workspaceId
    || binding.clientNamespace.length === 0
    || binding.clientInstanceId.length === 0
  ) {
    throw new LifecycleError("PROJECT_BINDING_REQUIRED");
  }
  const branchRef = context.workspace.kind === "git" ? context.workspace.branchRef : null;
  if (branchRef !== command.expectedBranchRef) {
    throw new LifecycleError("WORKSPACE_AMBIGUOUS");
  }
}

function protectedProofDigest(proofFingerprint: string): string {
  const bytes = Buffer.from(proofFingerprint, "hex");
  try {
    if (bytes.length !== 32) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
    return capabilityProofDigest(bytes);
  } finally {
    bytes.fill(0);
  }
}

function protectedBoundary<C extends RoutedPreparedCommand>(
  context: ProjectContext,
  preparedInput: PreparedLifecycleWorkerCommand<C>,
  commandType: C["commandType"],
): ProtectedBoundary<C> {
  const decoded = decodeLifecycleSemanticCommandDraft(preparedInput.command);
  if (decoded.commandType !== commandType) throw new LifecycleError("LIFECYCLE_INPUT_INVALID");
  const command = decoded as C;
  assertSemanticCommandAuthorization(command, preparedInput.authorization);
  assertContext(context, command);
  const authorization = preparedInput.authorization;
  if (
    authorization.kind !== "protected"
    || authorization.proof === null
    || authorization.approval !== null
    || authorization.childBindingGrant !== null
  ) {
    throw new LifecycleError("SESSION_CAPABILITY_INVALID");
  }
  const digest = protectedProofDigest(authorization.proof.proofFingerprint);
  const authorizationSnapshot = Object.freeze({
    kind: "protected" as const,
    authoritySessionId: authorization.authoritySessionId,
    targetSessionId: authorization.targetSessionId,
    proof: Object.freeze({ ...authorization.proof }),
    approval: null,
    childBindingGrant: null,
  });
  const principal = Object.freeze({
    actorRole: context.binding.actorRole,
    clientInstanceId: context.binding.clientInstanceId,
  });
  return Object.freeze({
    command,
    prepared: Object.freeze({
      command,
      candidateIntentHash: preparedInput.candidateIntentHash,
      authorization: authorizationSnapshot,
    }) as PreparedLifecycleWorkerCommand<C>,
    capabilityKind: context.binding.actorRole === "primary"
      ? "root-session-handle"
      : "child-session-handle",
    replayExpectation: Object.freeze({
      kind: "protected",
      proof: Object.freeze({
        version: 1,
        nonce: authorization.proof.proofNonce,
        digest,
      }),
      approval: null,
      authorizationSessionId: authorization.authoritySessionId,
      targetSessionId: authorization.targetSessionId,
      presenting: principal,
      target: principal,
    }),
    proofDigest: digest,
  });
}

function storedHandle(
  context: ProjectContext,
  authority: SessionAuthorityRecord,
): StoredCapabilityMaterialV1 {
  const root = authority.sessionKind === "root";
  const generation = root ? authority.ownerGeneration : authority.childCapabilityGeneration;
  const capabilityVersion = root
    ? authority.rootHandleCapabilityVersion
    : authority.childHandleCapabilityVersion;
  const keyId = root ? authority.rootHandleKeyId : authority.childHandleKeyId;
  const issueNonce = root ? authority.rootHandleIssueNonce : authority.childHandleIssueNonce;
  const issuedAt = root ? authority.rootHandleIssuedAt : authority.childHandleIssuedAt;
  const policyCode = root ? authority.rootHandlePolicyCode : authority.childHandlePolicyCode;
  const expiryKind = root ? authority.rootHandleExpiryKind : authority.childHandleExpiryKind;
  const expiresAt = root ? authority.rootHandleExpiresAt : authority.childHandleExpiresAt;
  const actorRole = root ? authority.rootHandleActorRole : authority.childHandleActorRole;
  const clientInstanceId = root
    ? authority.rootHandleClientInstanceId
    : authority.childHandleClientInstanceId;
  const verifier = root ? authority.rootHandleVerifier : authority.childHandleVerifier;
  if (
    generation === null
    || capabilityVersion !== 1
    || keyId === null
    || issueNonce === null
    || issuedAt === null
    || policyCode === null
    || expiryKind === null
    || actorRole === null
    || clientInstanceId === null
    || verifier === null
  ) return integrityFailure();
  return Object.freeze({
    claims: Object.freeze({
      capabilityVersion: 1,
      keyId,
      projectId: authority.projectId,
      vaultId: context.binding.vaultId,
      storeId: context.binding.storeId,
      workspaceId: authority.workspaceId,
      clientNamespace: authority.clientNamespace,
      sessionId: authority.sessionId,
      kind: root ? "root-session-handle" : "child-session-handle",
      capabilityGeneration: generation.toString(),
      issuedAt,
      policyCode,
      expiryKind,
      expiresAt,
      issueNonce,
      actorRole,
      clientInstanceId,
    }),
    verifier,
  });
}

function verifiedProtectedInvocation<C extends RoutedPreparedCommand>(
  transaction: LifecycleCommandTransaction,
  context: ProjectContext,
  boundary: ProtectedBoundary<C>,
  capabilities: CapabilityService,
): VerifiedProtectedInvocation {
  const authority = semanticAuthorityOperations(transaction);
  const authorization = boundary.prepared.authorization;
  if (authorization.kind !== "protected" || authorization.proof === null) {
    throw new LifecycleError("SESSION_CAPABILITY_INVALID");
  }
  const observed = authority.get(context.binding.projectId, authorization.authoritySessionId);
  if (observed === null) throw new LifecycleError("SESSION_NOT_FOUND");
  const authorizationAuthority = Object.freeze({ ...observed }) as SessionAuthorityRecord;
  if (
    authorizationAuthority.revocationEventPosition !== null
    || authorizationAuthority.revokedAt !== null
    || authorizationAuthority.terminalEventPosition !== null
    || authorizationAuthority.terminalAt !== null
    || (authorizationAuthority.sessionKind === "root"
      && authorizationAuthority.semanticState !== "active")
    || (authorizationAuthority.sessionKind === "child"
      && !authorizationAuthority.directAccessEnabled)
  ) {
    throw new LifecycleError("SESSION_HANDLE_STALE");
  }
  const generation = authorizationAuthority.sessionKind === "root"
    ? authorizationAuthority.ownerGeneration?.toString()
    : authorizationAuthority.childCapabilityGeneration?.toString();
  if (generation === undefined || generation === null) {
    throw new LifecycleError("SESSION_HANDLE_STALE");
  }
  if (
    authorizationAuthority.projectId !== context.binding.projectId
    || authorizationAuthority.workspaceId !== context.binding.workspaceId
    || authorizationAuthority.clientNamespace !== context.binding.clientNamespace
    || (authorizationAuthority.sessionKind === "root" && (
      context.binding.actorRole !== "primary"
      || authorizationAuthority.rootHandleClientInstanceId
        !== context.binding.clientInstanceId
    ))
    || (authorizationAuthority.sessionKind === "child" && (
      context.binding.actorRole !== "untrusted"
      || authorizationAuthority.childHandleClientInstanceId
        !== context.binding.clientInstanceId
    ))
  ) {
    throw new LifecycleError("SESSION_OWNERSHIP_MISMATCH");
  }
  if (
    boundary.capabilityKind
      !== (authorizationAuthority.sessionKind === "root"
        ? "root-session-handle"
        : "child-session-handle")
  ) return integrityFailure();
  const targetObserved = authority.get(
    context.binding.projectId,
    authorization.targetSessionId,
  );
  if (targetObserved === null) throw new LifecycleError("SESSION_NOT_FOUND");
  const targetAuthority = Object.freeze({ ...targetObserved }) as SessionAuthorityRecord;
  const targetAggregate = Object.freeze({
    ...authority.requireFoldMatch(targetAuthority),
  }) as import("../lifecycle/session-aggregate.js").SessionAggregateState;
  const assertions = {
    authorizationKind: "protected" as const,
    authorizationSessionId: authorization.authoritySessionId,
    targetSessionId: authorization.targetSessionId,
    projectId: context.binding.projectId,
    vaultId: context.binding.vaultId,
    storeId: context.binding.storeId,
    workspaceId: context.binding.workspaceId,
    clientNamespace: context.binding.clientNamespace,
    capabilityKind: boundary.capabilityKind,
    capabilityGeneration: generation,
    presentingActorRole: context.binding.actorRole,
    presentingClientInstanceId: context.binding.clientInstanceId,
    targetActorRole: context.binding.actorRole,
    targetClientInstanceId: context.binding.clientInstanceId,
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  };
  const authoritative = buildLifecycleIntentWitness(boundary.command, assertions);
  if (
    !/^[0-9a-f]{64}$/.test(boundary.prepared.candidateIntentHash)
    || authoritative.intentHash !== boundary.prepared.candidateIntentHash
  ) {
    throw new LifecycleError("IDEMPOTENCY_CONFLICT");
  }
  const proofTarget: SemanticCommandProofTargetV1 = {
    proofVersion: 1,
    target: "semantic-command",
    projectId: context.binding.projectId,
    vaultId: context.binding.vaultId,
    storeId: context.binding.storeId,
    workspaceId: context.binding.workspaceId,
    clientNamespace: context.binding.clientNamespace,
    authoritySessionId: authorization.authoritySessionId,
    targetSessionId: authorization.targetSessionId,
    presentingActorRole: context.binding.actorRole,
    presentingClientInstanceId: context.binding.clientInstanceId,
    targetActorRole: context.binding.actorRole,
    targetClientInstanceId: context.binding.clientInstanceId,
    capabilityKind: boundary.capabilityKind,
    capabilityGeneration: generation,
    commandId: boundary.command.commandId,
    idempotencyKey: boundary.command.idempotencyKey,
    intentHash: authoritative.intentHash,
    proofNonce: authorization.proof.proofNonce,
  };
  const verifiedProof = capabilities.verifyProof(
    storedHandle(context, authorizationAuthority),
    proofTarget,
    authorization.proof,
  );
  if (verifiedProof.digest !== boundary.proofDigest) return integrityFailure();
  return Object.freeze({
    generation,
    authorizationRecord: Object.freeze({
      ...boundary.replayExpectation,
      proof: Object.freeze(verifiedProof),
    }),
    authorizationAuthority,
    targetAuthority,
    targetAggregate,
  });
}

const NOT_ISSUED_AUTHORITY_MATERIAL: WorkerAuthorityMaterialResultV1 = Object.freeze({
  status: "not-issued",
  target: null,
  authorityCommitment: null,
  capabilityGeneration: null,
  descriptor: null,
  recoveryCode: null,
});

function successfulWorkerResult<T extends JsonValue>(
  publicResult: T,
): WorkerLifecycleResult<T> {
  return Object.freeze({
    kind: "success",
    publicResult,
    authorityMaterial: NOT_ISSUED_AUTHORITY_MATERIAL,
  });
}

class ConnectionBoundPreparedCheckpointHandler
implements PreparedCheckpointLifecycleHandler {
  readonly #scopes = new WeakMap<
    LifecycleCommandTransaction,
    TrustedCheckpointInvocationV1
  >();
  readonly #service: CheckpointService;
  readonly #connection: SqliteConnection;
  readonly #store: LifecycleCommandStore;
  readonly #capabilities: CapabilityService;
  readonly #sourceStateScopes: SourceStateScopeResolver;

  constructor(
    connection: SqliteConnection,
    store: LifecycleCommandStore,
    capabilities: CapabilityService,
    sourceStateScopes: SourceStateScopeResolver,
    sourceStateProvider: SourceStateProvider,
    identitySource: LifecycleRuntimeIdentitySource,
    clock: LifecycleRuntimeClock,
    faultInjector?: LifecycleFaultInjector,
  ) {
    this.#connection = connection;
    this.#store = store;
    this.#capabilities = capabilities;
    this.#sourceStateScopes = sourceStateScopes;
    this.#service = new CheckpointService({
      invocationScope: {
        current: (transaction) => {
          const scope = this.#scopes.get(transaction);
          if (scope === undefined) return integrityFailure();
          return scope;
        },
      },
      sourceStateProvider,
      identitySource,
      clock: { now: () => clock.now() },
      ...(faultInjector === undefined ? {} : { faultInjector }),
    });
  }

  execute(
    context: ProjectContext,
    prepared: PreparedLifecycleWorkerCommand<
      RecordCheckpointCommandV2 | RecordCheckpointCommandV3
    >,
  ): WorkerLifecycleResult<CheckpointRecordedResult> {
    const boundary = protectedBoundary(context, prepared, "record-checkpoint");
    const execution = this.#store.execute<CheckpointRecordedResult>({
      context,
      commandId: boundary.command.commandId,
      idempotencyKey: boundary.command.idempotencyKey,
      commandType: boundary.command.commandType,
      candidateIntentHash: boundary.prepared.candidateIntentHash,
      authoritativeIntentHash: boundary.prepared.candidateIntentHash,
      semanticCommand: boundary.command,
      capabilityKind: boundary.capabilityKind,
      capabilityGeneration: null,
      capabilityGenerationResolution: "fresh-commit",
      replayExpectation: boundary.replayExpectation,
    }, (transaction) => {
      const verified = verifiedProtectedInvocation(
        transaction,
        context,
        boundary,
        this.#capabilities,
      );
      const invocation: TrustedCheckpointInvocationV1 = Object.freeze({
        context,
        sourceStateScope: this.#sourceStateScopes.resolve(this.#connection, context),
        authorizationRecord: verified.authorizationRecord,
        freshCapabilityGeneration: verified.generation,
      });
      this.#scopes.set(transaction, invocation);
      try {
        return this.#service.record(transaction, boundary.command);
      } finally {
        this.#scopes.delete(transaction);
      }
    });
    return successfulWorkerResult(execution.publicResult);
  }
}

class ConnectionBoundPreparedEvidenceHandler
implements PreparedEvidenceLifecycleHandler {
  readonly #scopes = new WeakMap<
    LifecycleCommandTransaction,
    TrustedEvidenceCoverageInvocationV2
  >();
  readonly #service: EvidenceCoverageService;
  readonly #store: LifecycleCommandStore;
  readonly #capabilities: CapabilityService;
  readonly #clock: LifecycleRuntimeClock;

  constructor(
    store: LifecycleCommandStore,
    capabilities: CapabilityService,
    clock: LifecycleRuntimeClock,
    faultInjector?: LifecycleFaultInjector,
  ) {
    this.#store = store;
    this.#capabilities = capabilities;
    this.#clock = clock;
    this.#service = new EvidenceCoverageService({
      invocationScope: {
        current: (transaction) => {
          const scope = this.#scopes.get(transaction);
          if (scope === undefined) return integrityFailure();
          return scope;
        },
      },
      ...(faultInjector === undefined ? {} : { faultInjector }),
    });
  }

  execute(
    context: ProjectContext,
    prepared: PreparedLifecycleWorkerCommand<RecordEvidenceBatchCommandV2>,
  ): WorkerLifecycleResult<EvidenceCoverageRecordedResultV2> {
    const boundary = protectedBoundary(context, prepared, "record-evidence-batch");
    const execution = this.#store.execute<EvidenceCoverageRecordedResultV2>({
      context,
      commandId: boundary.command.commandId,
      idempotencyKey: boundary.command.idempotencyKey,
      commandType: boundary.command.commandType,
      candidateIntentHash: boundary.prepared.candidateIntentHash,
      authoritativeIntentHash: boundary.prepared.candidateIntentHash,
      semanticCommand: boundary.command,
      capabilityKind: boundary.capabilityKind,
      capabilityGeneration: null,
      capabilityGenerationResolution: "fresh-commit",
      replayExpectation: boundary.replayExpectation,
    }, (transaction) => {
      const verified = verifiedProtectedInvocation(
        transaction,
        context,
        boundary,
        this.#capabilities,
      );
      const invocation: TrustedEvidenceCoverageInvocationV2 = Object.freeze({
        context,
        authorizationRecord: verified.authorizationRecord,
        freshCapabilityGeneration: verified.generation,
        authorizationAuthority: verified.authorizationAuthority,
        targetAuthority: verified.targetAuthority,
        targetAggregate: verified.targetAggregate,
        occurredAt: this.#clock.now(),
      });
      this.#scopes.set(transaction, invocation);
      try {
        return this.#service.record(transaction, boundary.command);
      } finally {
        this.#scopes.delete(transaction);
      }
    });
    return successfulWorkerResult(execution.publicResult);
  }
}

function validateFactoryOptions(
  options: LifecycleWorkerRuntimeFactoryOptions,
): LifecycleWorkerRuntimeFactoryOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return integrityFailure();
  }
  const clock = ownDataProperty<LifecycleRuntimeClock>(options, "clock");
  const identitySource = ownDataProperty<LifecycleRuntimeIdentitySource>(
    options,
    "identitySource",
  );
  const integrity = ownDataProperty<LifecycleProcessorIntegrity>(options, "integrity");
  const resumeSourceState = ownDataProperty<LifecycleResumeSourceStatePort>(
    options,
    "resumeSourceState",
  );
  const checkpointSourceStateProvider = ownDataProperty<SourceStateProvider>(
    options,
    "checkpointSourceStateProvider",
  );
  const checkpointSourceStateScopeResolver = ownDataProperty<SourceStateScopeResolver>(
    options,
    "checkpointSourceStateScopeResolver",
  );
  const childBindingFingerprint = ownDataProperty<
    ChildWorkflowServiceOptions["childBindingFingerprint"]
  >(options, "childBindingFingerprint");
  const repositories = ownDataProperty<LifecycleRuntimeRepositoryFactories>(
    options,
    "repositories",
  );
  const transactionFacades = ownDataProperty<LifecycleTransactionFacadeFactory>(
    options,
    "transactionFacades",
  );
  const validationProfileRegistry = ownOptionalDataProperty<TrustedValidationProfileRegistry>(
    options,
    "validationProfileRegistry",
  );
  const faultInjector = ownOptionalDataProperty<LifecycleFaultInjector>(options, "faultInjector");
  const onSessionEndCoordinatorCreated = ownOptionalDataProperty<
    NonNullable<LifecycleWorkerRuntimeFactoryOptions["onSessionEndCoordinatorCreated"]>
  >(options, "onSessionEndCoordinatorCreated");
  if (
    typeof clock?.nowMs !== "function"
    || typeof clock.now !== "function"
    || typeof identitySource?.uuid !== "function"
    || typeof identitySource.bytes !== "function"
    || typeof integrity?.assertQuickHealthy !== "function"
    || typeof resumeSourceState?.captureCurrent !== "function"
    || typeof checkpointSourceStateProvider?.capture !== "function"
    || typeof checkpointSourceStateProvider.captureForCheckpoint !== "function"
    || typeof checkpointSourceStateProvider.captureForFinalization !== "function"
    || typeof checkpointSourceStateScopeResolver?.resolve !== "function"
    || typeof childBindingFingerprint !== "function"
    || typeof repositories?.authority !== "function"
    || typeof repositories.leases !== "function"
    || typeof repositories.approvals !== "function"
    || typeof repositories.transfers !== "function"
    || typeof repositories.coverage !== "function"
    || typeof repositories.projection !== "function"
    || typeof transactionFacades?.command !== "function"
    || typeof transactionFacades.operational !== "function"
    || (validationProfileRegistry !== undefined
      && (typeof validationProfileRegistry.resolve !== "function"
        || typeof validationProfileRegistry.list !== "function"))
    || (onSessionEndCoordinatorCreated !== undefined && typeof onSessionEndCoordinatorCreated !== "function")
  ) return integrityFailure();
  return Object.freeze({
    clock,
    identitySource,
    integrity,
    resumeSourceState,
    checkpointSourceStateProvider,
    checkpointSourceStateScopeResolver,
    childBindingFingerprint,
    repositories,
    transactionFacades,
    validationProfileRegistry,
    ...(faultInjector === undefined ? {} : { faultInjector }),
    ...(onSessionEndCoordinatorCreated === undefined ? {} : { onSessionEndCoordinatorCreated }),
  });
}

function validateCreateInput(
  input: LifecycleWorkerRuntimeCreateInput,
): LifecycleWorkerRuntimeCreateInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return integrityFailure();
  }
  const connection = ownDataProperty<SqliteConnection>(input, "connection");
  const maintenanceFence = ownDataProperty<MaintenanceFence>(input, "maintenanceFence");
  const keyProvider = ownDataProperty<CapabilityKeyProvider>(input, "keyProvider");
  if (
    typeof connection?.exec !== "function"
    || typeof connection.prepare !== "function"
    || typeof connection.close !== "function"
    || typeof maintenanceFence !== "object"
    || maintenanceFence === null
    || typeof keyProvider?.currentKey !== "function"
    || typeof keyProvider.status !== "function"
    || typeof keyProvider.fingerprint !== "function"
    || typeof keyProvider.mac !== "function"
    || typeof keyProvider.verify !== "function"
    || typeof keyProvider.seal !== "function"
    || typeof keyProvider.open !== "function"
  ) return integrityFailure();
  return Object.freeze({ connection, maintenanceFence, keyProvider });
}

export class LifecycleWorkerRuntimeFactory
implements LifecycleWorkerRuntimeFactoryPort {
  readonly #options: LifecycleWorkerRuntimeFactoryOptions;

  constructor(options: LifecycleWorkerRuntimeFactoryOptions) {
    this.#options = validateFactoryOptions(options);
  }

  create(inputValue: LifecycleWorkerRuntimeCreateInput): LifecycleWorkerRuntime {
    const input = validateCreateInput(inputValue);
    const options = this.#options;
    const faultInjectorOptions = options.faultInjector === undefined
      ? {}
      : { faultInjector: options.faultInjector };
    const authority = options.repositories.authority(faultInjectorOptions);
    const leases = options.repositories.leases(faultInjectorOptions);
    const approvals = options.repositories.approvals();
    const transfers = options.repositories.transfers(faultInjectorOptions);
    const coverage = options.repositories.coverage(input.keyProvider);
    const projectionWriter = options.repositories.projection(input.connection);
    const validationResultsRepository = new LifecycleValidationResultRepository();
    const outboxRepository = new LifecycleOutboxRepository(faultInjectorOptions);
    const compatibilityLogMaterializer = new CompatibilityLogMaterializer({
      connection: input.connection,
      keyProvider: input.keyProvider,
      nowMs: () => options.clock.nowMs(),
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
    });
    const connectionBoundOutbox = createConnectionBoundLifecycleOutboxOperations(
      input.connection,
      outboxRepository,
      compatibilityLogMaterializer,
    );
    const planningReads = new SqliteLifecycleMaterializationPlanningReads(input.connection, {
      outboxRepository,
    });
    const planReader = Object.freeze({
      getExactPlannedRevision: (query: import("../lifecycle/materialization-queue.port.js").ExactPlannedRevisionQuery) =>
        outboxRepository.getExactPlannedRevision(input.connection, query),
      assertExactPlannedRevision: (query: import("../lifecycle/materialization-queue.port.js").ExactPlannedRevisionQuery) =>
        outboxRepository.assertExactPlannedRevision(input.connection, query),
    });
    const materializationQueue = new SqliteLifecycleMaterializationQueue({
      reads: planningReads,
      keyProvider: input.keyProvider,
      planReader,
    });
    const lifecycleOutboxWriter = Object.freeze({
      insertLifecycle: (
        connection: SqliteConnection,
        pending: PendingLifecycleOutboxV1,
        triggeringEvent: StoredEvent,
        createdAt: string,
      ) => outboxRepository.insertLifecycle(connection, pending, triggeringEvent, createdAt),
    });
    const capabilities = new CapabilityService({
      keyProvider: input.keyProvider,
      clock: options.clock,
      nonceSource: options.identitySource,
    });
    const events = new EventAppendTransaction(
      input.connection,
      new SqliteEventAppendStatements(input.connection, lifecycleOutboxWriter),
      input.maintenanceFence,
      new BranchScopeRepository({
        randomId: () => options.identitySource.uuid() as BranchScopeId,
      }),
      () => options.identitySource.uuid(),
      NO_EVENT_STORE_FAULTS,
    );
    const semanticStore = new LifecycleCommandStore({
      connection: input.connection,
      events,
      projectionWriter,
      transaction: (connection) => {
        if (connection !== input.connection) return integrityFailure();
        const provided = options.transactionFacades.command({
          connection,
          authority,
          leases,
          approvals,
          transfers,
          coverage,
        });
        return Object.freeze({
          ...provided,
          authority: Object.freeze({
            ...provided.authority,
            listChildHistoryBounded: (projectId: string, rootSessionId: string, limit: number) =>
              authority.listChildHistoryBounded(connection, projectId, rootSessionId, limit),
          }),
          transfers: Object.freeze({
            ...provided.transfers,
            listBySourceRoot: (projectId: string, rootSessionId: string, limit: number) =>
              transfers.listBySourceRoot(connection, projectId, rootSessionId, limit),
          }),
          workflows: new ConnectionBoundSessionEndWorkflowOperations(connection, faultInjectorOptions),
        });
      },
      evidenceCoverageRepository: coverage,
      validationResultsRepository,
      now: () => options.clock.now(),
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
    });
    const operationalStore = new LifecycleOperationalStore({
      connection: input.connection,
      transaction: (connection) => {
        if (connection !== input.connection) return integrityFailure();
        return options.transactionFacades.operational({ connection });
      },
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
      decorateTransaction: (provided, connection) => {
        const workflows = typeof provided.workflows.read === "function"
          && typeof provided.workflows.claimNext === "function"
          ? provided.workflows
          : new ConnectionBoundSessionEndWorkflowOperations(connection, faultInjectorOptions);
        const outboxPlans = provided.outboxPlans ?? planReader;
        const validationPlans: LifecycleValidationPlanReadOperations = provided.validationPlans
          ?? Object.freeze({
            readPersistedValidationAttemptPlansV1: (projectId: string, workflowId: string) =>
              readPersistedValidationAttemptPlansV1(connection, projectId, workflowId),
            writePersistedValidationAttemptPlansV1: (
              planInput: PersistedValidationAttemptPlansWriteV1,
            ) => {
              new SessionEndWorkflowRepository(connection, faultInjectorOptions)
                .writePersistedValidationAttemptPlansV1(planInput);
            },
          });
        const authorityReads: LifecycleSessionAuthorityReadOperations = provided.authority
          ?? Object.freeze({
            get: (projectId: string, sessionId: string) =>
              authority.get(connection, projectId, sessionId),
            listNonterminalChildren: (projectId: string, rootSessionId: string) =>
              authority.listNonterminalChildren(connection, projectId, rootSessionId),
            listChildHistoryBounded: (projectId: string, rootSessionId: string, limit: number) =>
              authority.listChildHistoryBounded(connection, projectId, rootSessionId, limit),
            requireFoldMatch: (record: SessionAuthorityRecord) =>
              authority.requireFoldMatch(connection, record),
            latestCheckpoint: (record: SessionAuthorityRecord) =>
              authority.latestCheckpoint(connection, record),
            requireCheckpointAtEventPosition: (checkpointInput: CheckpointAtEventPositionInput) =>
              authority.requireCheckpointAtEventPosition(connection, checkpointInput),
          });
        const transferReads: LifecycleChildTransferReadOperations = provided.transfers
          ?? Object.freeze({
            get: (projectId: string, transferTicketId: string) =>
              transfers.get(connection, projectId, transferTicketId),
            listUnclaimedBySourceRoot: (
              projectId: string,
              sourceParentSessionId: string,
              limit: number,
            ) => transfers.listUnclaimedBySourceRoot(
              connection,
              projectId,
              sourceParentSessionId,
              limit,
            ),
            listBySourceRoot: (
              projectId: string,
              sourceParentSessionId: string,
              limit: number,
            ) => transfers.listBySourceRoot(
              connection,
              projectId,
              sourceParentSessionId,
              limit,
            ),
            listUnclaimedEndingScopeProjectionsBySourceRoot: (
              projectId: string,
              sourceParentSessionId: string,
              limit: number,
            ) => transfers.listUnclaimedEndingScopeProjectionsBySourceRoot(
              connection,
              projectId,
              sourceParentSessionId,
              limit,
            ),
          });
        const coverageReads: LifecycleEvidenceCoverageReadOperations = provided.coverage
          ?? Object.freeze({
            assertQuickHealthy: (sessionIds: readonly import("../lifecycle/contracts/identifiers.js").SessionId[]) =>
              coverage.assertQuickHealthy(connection, sessionIds),
            assertVersion1Eligible: (sessionIds: readonly import("../lifecycle/contracts/identifiers.js").SessionId[]) =>
              coverage.assertVersion1Eligible(connection, sessionIds),
            snapshotV2: (
              sessionId: import("../lifecycle/contracts/identifiers.js").SessionId,
              baseEventPosition: bigint,
            ) => coverage.snapshotV2(connection, sessionId, baseEventPosition),
          });
        const outbox = provided.outbox !== undefined
          && typeof provided.outbox.materialize === "function"
          ? provided.outbox
          : connectionBoundOutbox;
        const materializations = provided.materializations
          ?? createConnectionBoundLifecycleMaterializationReads(connection, outboxRepository);
        return Object.freeze({
          ...provided,
          workflows,
          outbox,
          materializations,
          outboxPlans,
          validationPlans,
          authority: authorityReads,
          transfers: transferReads,
          coverage: coverageReads,
        });
      },
    });
    const rootProcessor = new LifecycleCommandProcessor({
      connection: input.connection,
      commandStore: semanticStore,
      authorityRepository: authority,
      leaseRepository: leases,
      approvalRepository: approvals,
      capabilityService: capabilities,
      clock: options.clock,
      identitySource: options.identitySource,
      integrity: options.integrity,
      resumeSourceState: options.resumeSourceState,
      checkpointSourceStateProvider: options.checkpointSourceStateProvider,
      checkpointSourceStateScopeResolver: options.checkpointSourceStateScopeResolver,
      materializationQueue,
      ...faultInjectorOptions,
    });
    const childService = new ChildWorkflowService({
      connection: input.connection,
      commandStore: semanticStore,
      authorityRepository: authority,
      capabilityService: capabilities,
      clock: options.clock,
      identitySource: options.identitySource,
      childBindingFingerprint: options.childBindingFingerprint,
    });
    const sessionEndChildService = new SessionEndChildService({
      connection: input.connection,
      commandStore: semanticStore,
      authorityRepository: authority,
      transferRepository: transfers,
      clock: options.clock,
    });
    const sessionEndCoordinator = new SessionEndCoordinator({
      connection: input.connection,
      commandStore: semanticStore,
      operationalStore,
      authorityRepository: authority,
      transferRepository: transfers,
      childService: sessionEndChildService,
      materializationQueue,
      clock: options.clock,
      identitySource: options.identitySource,
      sourceStateProvider: options.checkpointSourceStateProvider,
      sourceStateScopeResolver: options.checkpointSourceStateScopeResolver,
      validationProfileRegistry: options.validationProfileRegistry,
      validationResultsRepository,
      ...faultInjectorOptions,
    });
    const queryService = new LifecycleQueryService({
      connection: input.connection,
      authorityRepository: authority,
      capabilityService: capabilities,
    });
    const checkpointHandler = new ConnectionBoundPreparedCheckpointHandler(
      input.connection,
      semanticStore,
      capabilities,
      options.checkpointSourceStateScopeResolver,
      options.checkpointSourceStateProvider,
      options.identitySource,
      options.clock,
      options.faultInjector,
    );
    const evidenceHandler = new ConnectionBoundPreparedEvidenceHandler(
      semanticStore,
      capabilities,
      options.clock,
      options.faultInjector,
    );
    const runtime = new ConnectionBoundLifecycleWorkerRuntime({
      rootProcessor,
      childService,
      checkpointHandler,
      evidenceHandler,
      queryService,
      semanticStore,
      operationalStore,
    });
    const recoveryCoordinator = new LifecycleRecoveryCoordinator({ operationalStore });
    runtime.configureSessionEndRouting(sessionEndChildService, sessionEndCoordinator);
    runtime.configureRecoveryRouting(recoveryCoordinator);
    runtime.configureFencingClock(() => options.clock.nowMs());
    options.onSessionEndCoordinatorCreated?.(sessionEndCoordinator);
    return runtime;
  }
}
