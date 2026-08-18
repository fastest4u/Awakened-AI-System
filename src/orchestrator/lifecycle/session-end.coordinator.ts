import { createHash } from "node:crypto";

import type { JsonValue, PendingEvent, StoredEvent } from "../contracts/event.js";
import type { ProjectContext } from "../identity/contracts.js";
import type {
  CheckpointId,
  SessionId,
  TransferTicketId,
  WorkflowId,
} from "./contracts/identifiers.js";
import type { ChildTransferRepository } from "../storage/child-transfer.repository.js";
import {
  authorityMutation,
  committedAuthority,
  SessionAuthorityRepository,
} from "../storage/session-authority.repository.js";
import type {
  ChildTransferTicketRecord,
  SessionAuthorityRecord,
} from "../storage/lifecycle-storage.types.js";
import type { SessionAggregateState } from "./session-aggregate.js";
import type { Checkpoint } from "./contracts/checkpoint.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import type {
  CarryForwardChildActionV1,
  InternalCarryForwardChildPlanV1,
  InternalValidationResultCommand,
  InternalRootWorkflowPhaseCommand,
  InternalRootWorkflowPhasePlan,
  InternalWorkflowExecutionPlan,
  RecordCheckpointCommandV2,
  RecordCheckpointCommandV3,
  WorkflowClaimAssertionV1,
} from "./contracts/commands.js";
import type { ValidationAttemptPlanIdentityV1 } from "./contracts/commands.js";
import { assertInternalValidationResultBinding } from "./contracts/commands.js";
import type {
  FinalEndingScopeBindingV1,
  SessionEndPhaseResultV2,
  ValidationResultRecordedResultV1,
} from "./contracts/session-end.js";
import { LifecycleError } from "./errors.js";
import type {
  LifecycleCommandStore,
  LifecycleCommandTransaction,
  PreparedLifecycleCommit,
} from "./lifecycle-command.store.js";
import type { LifecycleMaterializationQueuePort } from "./materialization-queue.port.js";
import type { LifecycleOperationalStore } from "./lifecycle-operational.store.js";
import {
  decodeSessionEndCarryForwardTicketLineageV1,
  selectEligibleChild,
  SessionEndChildService,
} from "./session-end-child.service.js";
import {
  MAX_ROOT_CHILD_HISTORY_V1,
  sessionEndPhaseIdentityV1,
} from "./session-end-identifiers.js";
import {
  hydrateSessionEndEffectiveStateV1,
  readEffectiveStateSourceEventPositionV1,
  SessionEndWorkflowRepository,
  type SessionEndWorkflowClaimV1,
  type SessionEndWorkflowRecordV1,
} from "../storage/session-end.repository.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { PersistedLifecycleAuthorizationRecord, LifecycleReplayExpectation } from "../contracts/event.js";
import { buildLifecycleIntentWitness } from "./lifecycle-intent-witness.js";
import {
  CheckpointService,
  type CheckpointIdentitySource,
  type CheckpointServiceOptions,
  type FinalCheckpointWorkflowPhasePreparationInput,
  type TrustedCheckpointInvocationV1,
} from "./checkpoint.service.js";
import type { SourceStateProvider, SourceStateScopeResolver } from "./source-state.provider.js";
import type { LifecycleFaultInjector } from "./lifecycle-faults.js";
import {
  sessionEndFinalCheckpointStatusV2,
  sessionEndGenerationStatusV2,
  sessionEndMaterializationQueuedResultV2,
  sessionEndValidationStartedResultV2,
} from "./session-end-workflow.service.js";
import type { ExactPlannedRevisionQuery } from "./materialization-queue.port.js";
import type { LifecycleEventCodecResult } from "./contracts/events.js";
import {
  createValidationAttemptPlans,
  expandValidationAttemptPlans,
  TrustedValidationProfileRegistry,
  type ValidationProfileKey,
} from "./validation-profile.registry.js";
import { LifecycleValidationResultRepository } from "../storage/lifecycle-validation-result.repository.js";
import { authorityCommitment } from "./authority/authority-commitment.js";
import {
  decodeFinalEndingScopeBindingsV1,
  decodeValidationResultV1,
  type ValidationResultV1,
} from "./contracts/session-end.js";
import type { PreparedMaterializationQueueV1, MaterializationProjectionInputV1 } from "./materialization-queue.port.js";
import {
  classifyCoverageOnlyVerificationTerminalActionV1,
  normalizeCoverageOnlyVerificationTerminalActionV1,
} from "./session-end-policy.js";

export interface SessionEndCoordinatorClock {
  nowMs(): bigint;
  now(): string;
}

export interface SessionEndCoordinatorIdentitySource {
  uuid(): string;
}

export interface SessionEndCoordinatorDriveInput {
  readonly context: ProjectContext;
  readonly ownerId: string;
  readonly observedNowMs: bigint;
  readonly leaseDurationMs: bigint;
  readonly claim?: SessionEndWorkflowClaimV1;
}

export interface SessionEndCoordinatorOptions {
  readonly connection: SqliteConnection;
  readonly commandStore: LifecycleCommandStore;
  readonly operationalStore: LifecycleOperationalStore;
  readonly authorityRepository: SessionAuthorityRepository;
  readonly transferRepository: ChildTransferRepository;
  readonly childService: SessionEndChildService;
  readonly materializationQueue?: LifecycleMaterializationQueuePort;
  readonly clock: SessionEndCoordinatorClock;
  readonly identitySource: SessionEndCoordinatorIdentitySource;
  readonly checkpointSourceStateProvider?: unknown;
  readonly checkpointSourceStateScopeResolver?: unknown;
  readonly sourceStateProvider?: SourceStateProvider;
  readonly sourceStateScopeResolver?: SourceStateScopeResolver;
  readonly validationProfileRegistry?: TrustedValidationProfileRegistry;
  readonly validationResultsRepository?: LifecycleValidationResultRepository;
  /** Fixture-only fault injection; production composition leaves this unset. */
  readonly faultInjector?: LifecycleFaultInjector;
}

/**
 * Coverage-only policy can rewrite a passing validation terminal action.  The
 * semantic command identity is coupled to that action, so normalize before
 * the command reaches the store and regenerate all three deterministic
 * identity fields as one tuple.
 */
export function normalizeCoverageOnlyTerminalPhasePlanIdentityV1(
  policy: { readonly requireFullEvidence: boolean },
  plan: InternalRootWorkflowPhasePlan,
): InternalRootWorkflowPhasePlan {
  if (plan.plannedAction.action !== "record-verification-passed") return plan;
  const plannedAction = normalizeCoverageOnlyVerificationTerminalActionV1(
    policy,
    plan.plannedAction,
  );
  if (plannedAction.action === plan.plannedAction.action) return plan;
  const identity = sessionEndPhaseIdentityV1({
    projectId: plan.expectedProjectId,
    workflowId: plan.workflowId,
    workflowGeneration: plan.workflowGeneration,
    sourcePhase: plan.sourcePhase,
    action: plannedAction as unknown as JsonValue,
  });
  return Object.freeze({
    ...plan,
    commandId: identity.commandId,
    idempotencyKey: identity.idempotencyKey,
    plannedWorkId: identity.plannedWorkId,
    plannedAction,
  }) as InternalRootWorkflowPhasePlan;
}

/**
 * Durable session-end driver.  Selection and proof are deliberately kept
 * small and synchronous: one invocation claims at most one workflow action,
 * performs at most one child command or eventless phase CAS, and returns.
 */
export class SessionEndCoordinator {
  readonly #connection: SqliteConnection;
  readonly #commandStore: LifecycleCommandStore;
  readonly #operationalStore: LifecycleOperationalStore;
  readonly #authority: SessionAuthorityRepository;
  readonly #transfers: ChildTransferRepository;
  readonly #childService: SessionEndChildService;
  readonly #clock: SessionEndCoordinatorClock;
  readonly #ids: SessionEndCoordinatorIdentitySource;
  readonly #checkpoint: CheckpointService | null;
  readonly #materializationQueue: LifecycleMaterializationQueuePort | null;
  readonly #checkpointScopes = new WeakMap<object, TrustedCheckpointInvocationV1>();
  readonly #sourceStateProvider: SourceStateProvider | null;
  readonly #sourceStateScopes: SourceStateScopeResolver | null;
  readonly #validationRegistry: TrustedValidationProfileRegistry | null;
  readonly #validationResults: LifecycleValidationResultRepository;

  constructor(options: SessionEndCoordinatorOptions) {
    if (options === null || typeof options !== "object"
      || typeof options.connection?.exec !== "function"
      || typeof options.operationalStore?.execute !== "function"
      || typeof options.authorityRepository?.listNonterminalChildren !== "function"
      || typeof options.transferRepository?.listBySourceRoot !== "function"
      || typeof options.childService?.execute !== "function"
      || typeof options.clock?.nowMs !== "function"
      || typeof options.clock?.now !== "function"
      || typeof options.identitySource?.uuid !== "function"
      || (options.faultInjector !== undefined && typeof options.faultInjector.hit !== "function")) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    this.#connection = options.connection;
    this.#commandStore = options.commandStore;
    this.#operationalStore = options.operationalStore;
    this.#authority = options.authorityRepository;
    this.#transfers = options.transferRepository;
    this.#childService = options.childService;
    this.#clock = options.clock;
    this.#ids = options.identitySource;
    this.#materializationQueue = options.materializationQueue ?? null;
    this.#sourceStateProvider = options.sourceStateProvider ?? null;
    this.#sourceStateScopes = options.sourceStateScopeResolver ?? null;
    this.#validationRegistry = options.validationProfileRegistry ?? null;
    this.#validationResults = options.validationResultsRepository
      ?? new LifecycleValidationResultRepository();
    this.#checkpoint = options.sourceStateProvider !== undefined
      && options.sourceStateScopeResolver !== undefined
      ? new CheckpointService({
          invocationScope: {
            current: (transaction, _command) => {
              const scope = this.#checkpointScopes.get(transaction as object);
              if (scope === undefined) throw new LifecycleError("INTEGRITY_FAILURE");
              return scope;
            },
          },
          sourceStateProvider: options.sourceStateProvider,
          identitySource: options.identitySource as CheckpointIdentitySource,
          clock: { now: () => options.clock.now() },
          materializationQueue: options.materializationQueue,
          ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
        } satisfies CheckpointServiceOptions)
      : null;
  }

  /** Runtime owner for internal root workflow-phase plans. */
  execute(
    context: ProjectContext,
    plan: InternalWorkflowExecutionPlan,
  ): JsonValue {
    if (plan.commandType === "internal-validation-result") {
      return this.#recordValidationResult(context, plan);
    }
    if (plan.commandType !== "internal-workflow-phase") {
      throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
    }
    if (plan.plannedAction.action === "carry-forward-child") {
      return this.#childService.execute(context, plan as never) as unknown as JsonValue;
    }
    if (plan.plannedAction.action === "prepare-final-checkpoint-and-queue-ending") {
      return this.#executeRoot(context, plan as InternalRootWorkflowPhasePlan);
    }
    if (
      plan.plannedAction.action === "record-verification-failed"
      || plan.plannedAction.action === "record-verification-passed"
      || plan.plannedAction.action === "invalidate-verification"
      || plan.plannedAction.action === "append-terminal-completion"
    ) {
      return this.#executeTerminalPhase(context, plan as InternalRootWorkflowPhasePlan);
    }
    throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
  }

  driveOnce(input: SessionEndCoordinatorDriveInput): JsonValue | null {
    const claim = input.claim ?? this.#claimNext(input);
    if (claim === null) return null;
    const workflow = new SessionEndWorkflowRepository(this.#connection).read(
      claim.projectId,
      claim.workflowId,
    );
    if (workflow === null) throw new LifecycleError("SESSION_NOT_FOUND");
    if (workflow.phase === "requested") {
      const children = this.#authority.listNonterminalChildren(
        this.#connection,
        workflow.projectId,
        workflow.sessionId,
      );
      const child = selectEligibleChild(children);
      if (child !== null) {
        const plan = this.#childPlan(input.context, claim, child);
        const result = this.#childService.execute(input.context, plan) as unknown as JsonValue;
        this.#releaseClaim(claim);
        return result;
      }
      return this.#resolveChildren(input, claim, workflow);
    }
    if (workflow.phase === "children-resolved") {
      const plan = this.#finalPlan(input.context, claim, workflow);
      return this.#executeRoot(input.context, plan);
    }
    if (workflow.phase === "final-checkpoint-recorded") {
      return this.#confirmEndingMaterialization(input, claim, workflow);
    }
    if (workflow.phase === "ending-materialization-queued") {
      return this.#beginValidation(input, claim, workflow);
    }
    if (workflow.phase === "completion-appended") {
      return this.#materializationRequired(workflow)
        ? this.#confirmCompletedMaterialization(input, claim, workflow)
        : this.#completeWithoutMaterialization(input, claim, workflow);
    }
    if (workflow.phase === "completed-materialization-confirmed") {
      return this.#completeAfterMaterialization(input, claim, workflow);
    }
    return this.#status(workflow, false);
  }

  #finalPlan(
    context: ProjectContext,
    claim: SessionEndWorkflowClaimV1,
    workflow: SessionEndWorkflowRecordV1,
  ): InternalRootWorkflowPhasePlan {
    if (workflow.phase !== "children-resolved"
      || workflow.workflowId !== claim.workflowId
      || workflow.sessionId !== claim.sessionId
      || workflow.generation !== claim.workflowGeneration
      || workflow.evidenceWindowState !== "sealed"
      || workflow.evidenceFrozenCheckpointEventPosition !== null
      || workflow.evidenceFrozenGeneration !== null) {
      throw new LifecycleError("SESSION_END_INCOMPLETE");
    }
    // The mutable row selects the generation, but the draft itself is read
    // from the immutable request/amendment event fold.  This keeps a stale
    // coordinator plan from smuggling a replacement checkpoint into the
    // final transaction.
    const hydrated = hydrateSessionEndEffectiveStateV1(this.#connection, {
      projectId: workflow.projectId,
      workflowId: workflow.workflowId,
      workflowGeneration: workflow.generation,
      sessionId: workflow.sessionId,
      eventPosition: workflow.triggeringEventPosition,
    });
    if (hydrated.workflowId !== workflow.workflowId
      || hydrated.workflowGeneration !== workflow.generation
      || hydrated.effectiveState.request.sessionId !== workflow.sessionId) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    const plannedAction = Object.freeze({
      action: "prepare-final-checkpoint-and-queue-ending" as const,
      finalCheckpointDraft: hydrated.effectiveState.effectiveFinalCheckpoint,
      materializationTarget: "memory/session-end.md",
    }) as unknown as InternalRootWorkflowPhasePlan["plannedAction"];
    const identity = sessionEndPhaseIdentityV1({
      projectId: workflow.projectId as ProjectContext["binding"]["projectId"],
      workflowId: workflow.workflowId as WorkflowId,
      workflowGeneration: workflow.generation,
      sourcePhase: workflow.phase,
      action: plannedAction as unknown as JsonValue,
    });
    return Object.freeze({
      commandType: "internal-workflow-phase" as const,
      commandId: identity.commandId,
      idempotencyKey: identity.idempotencyKey,
      agentId: claim.ownerId,
      expectedProjectId: context.binding.projectId,
      expectedVaultId: context.binding.vaultId,
      expectedWorkspaceId: context.binding.workspaceId,
      expectedBranchRef: context.workspace.kind === "git" ? context.workspace.branchRef : null,
      workflowId: workflow.workflowId as WorkflowId,
      workflowGeneration: workflow.generation,
      sourcePhase: "children-resolved" as const,
      plannedWorkId: identity.plannedWorkId,
      claim: {
        workflowId: workflow.workflowId as WorkflowId,
        workflowGeneration: workflow.generation,
        claimOwnerId: claim.ownerId,
        claimToken: claim.claimToken.toString(),
        claimExpiresAt: claim.claimExpiresAt,
      },
      plannedAction,
    });
  }

  #confirmEndingMaterialization(
    input: SessionEndCoordinatorDriveInput,
    claim: SessionEndWorkflowClaimV1,
    workflow: SessionEndWorkflowRecordV1,
  ): SessionEndPhaseResultV2 {
    if (workflow.phase !== "final-checkpoint-recorded"
      || workflow.evidenceWindowState !== "sealed"
      || workflow.evidenceFrozenCheckpointEventPosition === null
      || workflow.evidenceFrozenGeneration !== workflow.generation
      || workflow.finalEndingScopeBindingsJson === null
      || claim.phase !== "final-checkpoint-recorded") {
      throw new LifecycleError("SESSION_END_INCOMPLETE");
    }
    const exactQuery: ExactPlannedRevisionQuery = {
      projectId: workflow.projectId as ProjectContext["binding"]["projectId"],
      sessionId: workflow.sessionId as SessionId,
      artifactKind: "compatibility-session-log",
      materializationRevision: workflow.evidenceFrozenCheckpointEventPosition,
      triggeringEventPosition: workflow.evidenceFrozenCheckpointEventPosition,
      origin: {
        kind: "workflow",
        workflowId: workflow.workflowId as WorkflowId,
        workflowGeneration: workflow.generation,
      },
      triggeringEventType: "SessionCheckpointRecorded",
    };
    const result = this.#operationalStore.execute({
      kind: "workflow",
      projectId: claim.projectId,
      workflowId: claim.workflowId as WorkflowId,
      workflowGeneration: BigInt(claim.workflowGeneration),
      operation: "advance-eventless",
      ownerId: claim.ownerId,
      claimToken: claim.claimToken,
    }, (transaction) => {
      // This assertion is intentionally before the phase CAS and performs no
      // semantic append.  A lost renderer/outbox commit therefore leaves the
      // workflow retryable at the frozen phase.
      transaction.outboxPlans.assertExactPlannedRevision(exactQuery);
      const progressed = transaction.workflows.advanceEventlessPhase({
        projectId: claim.projectId,
        workflowId: claim.workflowId,
        workflowGeneration: claim.workflowGeneration,
        expectedPhase: "final-checkpoint-recorded",
        nextPhase: "ending-materialization-queued",
        ownerId: claim.ownerId,
        claimToken: claim.claimToken,
        observedNowMs: input.observedNowMs,
        resultJson: canonicalJson(sessionEndMaterializationQueuedResultV2(workflow)),
      });
      return { progressed };
    });
    if (!(result.publicResult as { readonly progressed?: unknown }).progressed) {
      const current = new SessionEndWorkflowRepository(this.#connection).read(
        workflow.projectId,
        workflow.workflowId,
      );
      if (current === null) throw new LifecycleError("SESSION_NOT_FOUND");
      return this.#status(current, false);
    }
    return sessionEndMaterializationQueuedResultV2(workflow);
  }

  #beginValidation(
    input: SessionEndCoordinatorDriveInput,
    claim: SessionEndWorkflowClaimV1,
    workflow: SessionEndWorkflowRecordV1,
  ): SessionEndPhaseResultV2 {
    const registry = this.#validationRegistry;
    if (registry === null) throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
    const result = this.#operationalStore.execute({
      kind: "workflow",
      projectId: claim.projectId,
      workflowId: claim.workflowId as WorkflowId,
      workflowGeneration: BigInt(claim.workflowGeneration),
      operation: "advance-eventless",
      ownerId: claim.ownerId,
      claimToken: claim.claimToken,
    }, (transaction) => {
      const current = transaction.workflows.read(claim.projectId, claim.workflowId);
      if (current === null) throw new LifecycleError("SESSION_NOT_FOUND");
      if (
        current.workflowId !== workflow.workflowId
        || current.sessionId !== workflow.sessionId
        || current.generation !== workflow.generation
        || current.phase !== "ending-materialization-queued"
        || current.evidenceWindowState !== "sealed"
        || current.evidenceFrozenCheckpointEventPosition === null
        || current.evidenceFrozenGeneration !== current.generation
        || current.finalEndingScopeBindingsJson === null
        || current.coordinatorOwnerId !== claim.ownerId
        || current.coordinatorClaimToken !== claim.claimToken
        || current.coordinatorClaimExpiresAt !== claim.claimExpiresAt
      ) throw new LifecycleError("SESSION_END_INCOMPLETE");

      const exactQuery: ExactPlannedRevisionQuery = {
        projectId: current.projectId as ProjectContext["binding"]["projectId"],
        sessionId: current.sessionId as SessionId,
        artifactKind: "compatibility-session-log",
        materializationRevision: current.evidenceFrozenCheckpointEventPosition,
        triggeringEventPosition: current.evidenceFrozenCheckpointEventPosition,
        origin: {
          kind: "workflow",
          workflowId: current.workflowId as WorkflowId,
          workflowGeneration: current.generation,
        },
        triggeringEventType: "SessionCheckpointRecorded",
      };
      transaction.outboxPlans.assertExactPlannedRevision(exactQuery);

      const root = this.#authority.get(
        this.#connection,
        current.projectId,
        current.sessionId,
      );
      if (root === null) throw new LifecycleError("SESSION_NOT_FOUND");
      const aggregate = this.#authority.requireFoldMatch(this.#connection, root);
      if (
        root.sessionKind !== "root"
        || root.parentSessionId !== null
        || root.semanticState !== "ending"
        || aggregate.kind !== "root"
        || aggregate.state !== "ending"
        || root.authorityCommitment !== current.expectedAuthorityCommitment
        || root.latestCheckpointId === null
        || root.latestCheckpointEventPosition !== current.evidenceFrozenCheckpointEventPosition
        || root.latestCheckpointFingerprint === null
      ) throw new LifecycleError("SESSION_SOURCE_STATE_CONFLICT");

      const checkpoint = this.#authority.requireCheckpointAtEventPosition(this.#connection, {
        projectId: current.projectId as ProjectContext["binding"]["projectId"],
        sessionId: current.sessionId as SessionId,
        checkpointId: root.latestCheckpointId as CheckpointId,
        checkpointEventPosition: current.evidenceFrozenCheckpointEventPosition,
      });
      const checkpointBytes = Buffer.from(
        `project-memory/checkpoint/v${checkpoint.checkpointVersion}\n${canonicalJson(checkpoint)}`,
        "utf8",
      );
      let checkpointFingerprint: string;
      try {
        checkpointFingerprint = createHash("sha256").update(checkpointBytes).digest("hex");
      } finally {
        checkpointBytes.fill(0);
      }
      if (
        checkpoint.checkpointId !== root.latestCheckpointId
        || checkpoint.checkpointEventPosition !== current.evidenceFrozenCheckpointEventPosition.toString()
        || root.latestCheckpointFingerprint !== checkpointFingerprint
      ) throw new LifecycleError("SESSION_SOURCE_STATE_CONFLICT");

      let frozenScope: readonly FinalEndingScopeBindingV1[];
      try {
        const parsed = JSON.parse(current.finalEndingScopeBindingsJson) as unknown;
        frozenScope = decodeFinalEndingScopeBindingsV1(parsed);
        if (canonicalJson(frozenScope) !== current.finalEndingScopeBindingsJson) {
          throw new LifecycleError("INTEGRITY_FAILURE");
        }
      } catch (error) {
        if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") throw error;
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const liveScope = this.#endingScopeBindings(root);
      if (canonicalJson(liveScope) !== canonicalJson(frozenScope)) {
        throw new LifecycleError("SESSION_SOURCE_STATE_CONFLICT");
      }

      const operationalCoverage = (transaction as unknown as {
        readonly coverage?: { readonly assertQuickHealthy?: (sessionIds: readonly SessionId[]) => void };
      }).coverage;
      if (operationalCoverage !== undefined
        && typeof operationalCoverage.assertQuickHealthy === "function") {
        const coverageSessions = Object.freeze([
          current.sessionId as SessionId,
          ...frozenScope.map((binding) => binding.childSessionId),
        ]);
        operationalCoverage.assertQuickHealthy(coverageSessions);
      }

      const sourcePosition = readEffectiveStateSourceEventPositionV1(this.#connection, {
        projectId: current.projectId,
        workflowId: current.workflowId,
        workflowGeneration: current.generation,
      });
      const hydrated = hydrateSessionEndEffectiveStateV1(this.#connection, {
        projectId: current.projectId,
        workflowId: current.workflowId,
        workflowGeneration: current.generation,
        sessionId: current.sessionId,
        eventPosition: sourcePosition,
      });
      if (
        hydrated.workflowId !== current.workflowId
        || hydrated.workflowGeneration !== current.generation
        || hydrated.effectiveState.request.sessionId !== current.sessionId
      ) throw new LifecycleError("INTEGRITY_FAILURE");

      const plannedIdentity = sessionEndPhaseIdentityV1({
        projectId: current.projectId as ProjectContext["binding"]["projectId"],
        workflowId: current.workflowId as WorkflowId,
        workflowGeneration: current.generation,
        sourcePhase: "ending-materialization-queued",
        action: { action: "begin-validation" },
      });
      const expansionContext = {
        projectId: input.context.binding.projectId,
        vaultId: input.context.binding.vaultId,
        storeId: input.context.binding.storeId,
        workspaceId: input.context.binding.workspaceId,
        sessionId: current.sessionId,
        workflowId: current.workflowId,
        workflowGeneration: current.generation,
        plannedWorkId: plannedIdentity.plannedWorkId,
        finalCheckpointId: checkpoint.checkpointId,
        finalCheckpointFingerprint: checkpointFingerprint,
      } as const;
      const profileKeys = hydrated.effectiveState.effectivePolicy.profiles.map((profile) => ({
        profileId: profile.profileId,
        profileVersion: profile.profileVersion,
      } satisfies ValidationProfileKey));
      const createdPlans = createValidationAttemptPlans({
        ...expansionContext,
        profiles: profileKeys,
      }, registry);
      const expectedConfigurationHashes = new Map(
        registry.list().map((profile) => [
          `${profile.profileId}\u0000${profile.profileVersion}`,
          profile.configurationHash,
        ] as const),
      );
      const validationPlans = (transaction as unknown as {
        readonly validationPlans?: {
          readonly readPersistedValidationAttemptPlansV1?: (projectId: string, workflowId: string) =>
            { readonly workflowGeneration: number; readonly plans: readonly unknown[] } | null;
          readonly writePersistedValidationAttemptPlansV1?: (planInput: {
            readonly projectId: string;
            readonly workflowId: string;
            readonly workflowGeneration: number;
            readonly plans: unknown;
          }) => void;
          readonly read?: (projectId: string, workflowId: string) =>
            { readonly workflowGeneration: number; readonly plans: readonly unknown[] } | null;
          readonly write?: (planInput: {
            readonly projectId: string;
            readonly workflowId: string;
            readonly workflowGeneration: number;
            readonly plans: unknown;
          }) => void;
        };
      }).validationPlans;
      const readPlans = typeof validationPlans?.readPersistedValidationAttemptPlansV1 === "function"
        ? validationPlans.readPersistedValidationAttemptPlansV1(current.projectId, current.workflowId)
        : typeof validationPlans?.read === "function"
          ? validationPlans.read(current.projectId, current.workflowId)
        : current.validationAttemptPlanGeneration === null || current.validationAttemptPlansJson === null
          ? null
          : transaction.workflows.readPersistedValidationAttemptPlansV1(
              current.projectId,
              current.workflowId,
            );
      const persistedPlans = readPlans === null ? createdPlans : readPlans.plans;
      if (readPlans !== null && readPlans.workflowGeneration !== current.generation) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const expanded = expandValidationAttemptPlans({
        plans: persistedPlans,
        context: expansionContext,
        expectedProfileConfigurationHashes: expectedConfigurationHashes,
      }, registry);
      if (canonicalJson(expanded.map((plan) => ({
        profileId: plan.profileId,
        profileVersion: plan.profileVersion,
        runId: plan.runId,
        resultId: plan.resultId,
        commandId: plan.resultCommandId,
        idempotencyKey: plan.resultIdempotencyKey,
      }))) !== canonicalJson(createdPlans)) {
        throw new LifecycleError("IDEMPOTENCY_CONFLICT");
      }
      if (readPlans === null) {
        if (typeof validationPlans?.writePersistedValidationAttemptPlansV1 === "function") {
          validationPlans.writePersistedValidationAttemptPlansV1({
            projectId: current.projectId,
            workflowId: current.workflowId,
            workflowGeneration: current.generation,
            plans: createdPlans,
          });
        } else if (typeof validationPlans?.write === "function") {
          validationPlans.write({
            projectId: current.projectId,
            workflowId: current.workflowId,
            workflowGeneration: current.generation,
            plans: createdPlans,
          });
        } else {
          transaction.workflows.writePersistedValidationAttemptPlansV1({
            projectId: current.projectId,
            workflowId: current.workflowId,
            workflowGeneration: current.generation,
            plans: createdPlans,
          });
        }
      }
      const next = sessionEndValidationStartedResultV2(current);
      const progressed = transaction.workflows.advanceEventlessPhase({
        projectId: current.projectId,
        workflowId: current.workflowId,
        workflowGeneration: current.generation,
        expectedPhase: "ending-materialization-queued",
        nextPhase: "validating",
        ownerId: claim.ownerId,
        claimToken: claim.claimToken,
        observedNowMs: input.observedNowMs,
        resultJson: canonicalJson(next),
      });
      if (!progressed) throw new LifecycleError("EVENT_CONFLICT");
      return next;
    });
    return result.publicResult as unknown as SessionEndPhaseResultV2;
  }

  #recordValidationResult(
    context: ProjectContext,
    plan: InternalValidationResultCommand,
  ): ValidationResultRecordedResultV1 {
    assertInternalValidationResultBinding(plan);
    const result = decodeValidationResultV1(plan.result);
    const rootSessionId = result.sessionId as SessionId;
    const presenting = Object.freeze({
      actorRole: context.binding.actorRole,
      clientInstanceId: context.binding.clientInstanceId,
    });
    const replayExpectation: Extract<LifecycleReplayExpectation, { kind: "internal-workflow" }> = Object.freeze({
      kind: "internal-workflow",
      workflowId: plan.workflowId,
      workflowGeneration: BigInt(plan.workflowGeneration),
      plannedWorkId: plan.plannedWorkId,
      authorizationSessionId: rootSessionId,
      targetSessionId: rootSessionId,
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
      authorizationSessionId: rootSessionId,
      targetSessionId: rootSessionId,
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
    const plannedWitness = buildLifecycleIntentWitness(plan, assertions);
    const execution = this.#commandStore.execute<ValidationResultRecordedResultV1>({
      context,
      commandId: plan.commandId,
      idempotencyKey: plan.idempotencyKey,
      commandType: plan.commandType,
      candidateIntentHash: plannedWitness.intentHash,
      authoritativeIntentHash: plannedWitness.intentHash,
      semanticCommand: plan,
      capabilityKind: null,
      capabilityGeneration: null,
      replayExpectation,
    }, (transaction: LifecycleCommandTransaction) => {
      const root = this.#authority.get(this.#connection, context.binding.projectId, rootSessionId);
      if (root === null) throw new LifecycleError("SESSION_NOT_FOUND");
      const aggregate = this.#authority.requireFoldMatch(this.#connection, root);
      const workflow = new SessionEndWorkflowRepository(this.#connection).read(
        context.binding.projectId,
        plan.workflowId,
      );
      if (
        root.sessionKind !== "root"
        || root.semanticState !== "ending"
        || aggregate.kind !== "root"
        || aggregate.state !== "ending"
        || workflow === null
        || workflow.sessionId !== root.sessionId
        || workflow.phase !== "validating"
        || workflow.generation !== plan.workflowGeneration
        || workflow.coordinatorOwnerId !== plan.claim.claimOwnerId
        || workflow.coordinatorClaimToken !== BigInt(plan.claim.claimToken)
        || workflow.coordinatorClaimExpiresAt !== plan.claim.claimExpiresAt
      ) throw new LifecycleError("SESSION_END_INCOMPLETE");
      const eventPosition = this.#authority.nextGlobalPosition(this.#connection);
      const eventOccurredAt = this.#clock.now();
      const payload = Object.freeze({
        workflowId: plan.workflowId,
        workflowGeneration: plan.workflowGeneration,
        plannedWorkId: plan.plannedWorkId,
        validationResult: result,
      }) as unknown as JsonValue;
      const publicResult = Object.freeze({
        resultVersion: 1,
        resultId: result.resultId,
        workflowId: plan.workflowId,
        workflowGeneration: plan.workflowGeneration,
        eventPosition: eventPosition.toString(),
        finalStreamVersion: (aggregate.streamVersion + 1n).toString(),
      }) as ValidationResultRecordedResultV1;
      const event: PendingEvent = {
        eventType: "SessionValidationResultRecorded",
        eventSchemaVersion: 1,
        occurredAt: eventOccurredAt,
        visibilityScope: "session",
        sessionId: root.sessionId,
        confidence: "high",
        verificationStatus: "verified",
        payload,
        sourceRefs: [],
        evidenceRefs: [],
        evidenceDigests: [],
      };
      return {
        append: {
          context,
          commandId: plan.commandId,
          idempotencyKey: plan.idempotencyKey,
          commandType: plan.commandType,
          correlationId: aggregate.correlationId,
          agentId: plan.agentId,
          expectedStreamVersion: aggregate.streamVersion,
          streamId: root.streamId,
          streamType: "session",
          events: [event],
          outbox: [],
          publicResponse: publicResult,
        },
        authorizationRecord,
        beforeAppend: (planned) => {
          if (
            planned.events.length !== 1
            || planned.events[0]?.globalPosition !== eventPosition
            || planned.events[0]?.streamVersion !== aggregate.streamVersion + 1n
          ) throw new LifecycleError("INTEGRITY_FAILURE");
        },
        afterAppend: (committed, currentTransaction) => {
          const appended = committed.events[0];
          if (
            committed.events.length !== 1
            || appended === undefined
            || appended.globalPosition !== eventPosition
            || appended.streamVersion !== aggregate.streamVersion + 1n
            || appended.eventType !== "SessionValidationResultRecorded"
          ) throw new LifecycleError("INTEGRITY_FAILURE");
          const validation = (currentTransaction as unknown as {
            readonly validation?: {
              readonly record?: (result: ValidationResultV1, event: StoredEvent) => void;
            };
          }).validation;
          if (validation === undefined || typeof validation.record !== "function") {
            throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
          }
          validation.record(result, appended);
          const nextAuthority = {
            ...root,
            authorityEventPosition: appended.globalPosition,
            updatedAt: appended.recordedAt,
          } as unknown as Parameters<SessionAuthorityRepository["compareAndSwap"]>[1]["next"];
          if (!this.#authority.compareAndSwap(this.#connection, {
            projectId: root.projectId,
            sessionId: root.sessionId,
            expectedState: "ending",
            expectedOwnerGeneration: root.ownerGeneration,
            expectedChildCapabilityGeneration: null,
            expectedAuthorityCommitment: root.authorityCommitment,
            next: nextAuthority,
          })) throw new LifecycleError("SESSION_HANDLE_STALE");
        },
      } as PreparedLifecycleCommit<ValidationResultRecordedResultV1>;
    });
    return execution.publicResult;
  }

  #executeTerminalPhase(
    context: ProjectContext,
    plan: InternalRootWorkflowPhasePlan,
  ): SessionEndPhaseResultV2 {
    const action = plan.plannedAction;
    if (
      action.action !== "record-verification-failed"
      && action.action !== "record-verification-passed"
      && action.action !== "invalidate-verification"
      && action.action !== "append-terminal-completion"
    ) throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
    const workflow = new SessionEndWorkflowRepository(this.#connection).read(
      context.binding.projectId,
      plan.workflowId,
    );
    if (workflow === null) throw new LifecycleError("SESSION_NOT_FOUND");
    if (action.action === "record-verification-passed") {
      const policyState = hydrateSessionEndEffectiveStateV1(this.#connection, {
        projectId: workflow.projectId,
        workflowId: workflow.workflowId,
        workflowGeneration: workflow.generation,
        sessionId: workflow.sessionId,
        eventPosition: readEffectiveStateSourceEventPositionV1(this.#connection, {
          projectId: workflow.projectId,
          workflowId: workflow.workflowId,
          workflowGeneration: workflow.generation,
        }),
      });
      plan = normalizeCoverageOnlyTerminalPhasePlanIdentityV1(
        policyState.effectiveState.effectivePolicy,
        plan,
      );
    }
    const effectiveAction = plan.plannedAction as typeof action;
    const rootSessionId = workflow.sessionId as SessionId;
    const root = this.#authority.get(this.#connection, workflow.projectId, rootSessionId);
    if (root === null) throw new LifecycleError("SESSION_NOT_FOUND");
    const aggregate = this.#authority.requireFoldMatch(this.#connection, root);
    const expectedPhase = effectiveAction.action === "record-verification-failed"
      || effectiveAction.action === "record-verification-passed"
      ? "validating" as const
      : "verification-passed" as const;
    const nextPhase = effectiveAction.action === "record-verification-failed"
      || effectiveAction.action === "invalidate-verification"
      ? "verification-failed" as const
      : effectiveAction.action === "record-verification-passed"
        ? "verification-passed" as const
        : "completion-appended" as const;
    if (
      root.sessionKind !== "root"
      || root.semanticState !== "ending"
      || aggregate.kind !== "root"
      || aggregate.state !== "ending"
      || workflow.phase !== expectedPhase
      || workflow.generation !== plan.workflowGeneration
      || workflow.coordinatorOwnerId !== plan.claim.claimOwnerId
      || workflow.coordinatorClaimToken !== BigInt(plan.claim.claimToken)
      || workflow.coordinatorClaimExpiresAt !== plan.claim.claimExpiresAt
    ) throw new LifecycleError("SESSION_END_INCOMPLETE");

    const eventPosition = this.#authority.nextGlobalPosition(this.#connection);
    const occurredAt = this.#clock.now();
    let eventType: "SessionEndVerificationFailed"
      | "SessionEndVerificationPassed"
      | "SessionEndVerificationInvalidated"
      | "SessionEnded";
    let payload: JsonValue;
    let qualityScore: number | null = null;
    let safeFailureCode: string | null = null;
    if (effectiveAction.action === "record-verification-failed") {
      eventType = "SessionEndVerificationFailed";
      safeFailureCode = effectiveAction.safeFailureCode;
      payload = {
        workflowId: plan.workflowId,
        workflowGeneration: plan.workflowGeneration,
        validationResultIds: [...effectiveAction.validationResultIds],
        safeFailureCode: effectiveAction.safeFailureCode,
      } as unknown as JsonValue;
    } else if (effectiveAction.action === "record-verification-passed") {
      eventType = "SessionEndVerificationPassed";
      qualityScore = effectiveAction.qualityScore;
      payload = {
        workflowId: plan.workflowId,
        workflowGeneration: plan.workflowGeneration,
        validationResultIds: [...effectiveAction.validationResultIds],
        qualityScore: effectiveAction.qualityScore,
      } as unknown as JsonValue;
    } else if (effectiveAction.action === "invalidate-verification") {
      eventType = "SessionEndVerificationInvalidated";
      if (aggregate.verificationPassedEventPosition === null) {
        throw new LifecycleError("SESSION_END_INCOMPLETE");
      }
      safeFailureCode = effectiveAction.safeFailureCode;
      payload = {
        workflowId: plan.workflowId,
        workflowGeneration: plan.workflowGeneration,
        previousVerificationEventPosition: aggregate.verificationPassedEventPosition.toString(),
        safeFailureCode: effectiveAction.safeFailureCode,
      } as unknown as JsonValue;
    } else {
      eventType = "SessionEnded";
      const provisional = Object.freeze({
        ...root,
        semanticState: "ended" as const,
        authorityEventPosition: eventPosition,
        terminalEventPosition: eventPosition,
        terminalEventType: "SessionEnded" as const,
        terminalAt: occurredAt,
        updatedAt: occurredAt,
      });
      const nextCommitment = authorityCommitment(committedAuthority(provisional));
      payload = {
        workflowId: plan.workflowId,
        workflowGeneration: plan.workflowGeneration,
        verificationEventPosition: effectiveAction.verificationEventPosition,
        authorityCommitment: nextCommitment,
      } as unknown as JsonValue;
    }
    const materializationQueue = this.#materializationQueue;
    let preparedMaterialization: PreparedMaterializationQueueV1 | undefined;
    if (eventType !== "SessionEndVerificationPassed") {
      if (materializationQueue === null) {
        throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
      }
      const materializationEventType = eventType;
      preparedMaterialization = materializationQueue.prepare({
        context,
        sessionId: rootSessionId,
        artifactKind: "compatibility-session-log",
        triggeringEventIndex: 0,
        expectedTriggerPosition: eventPosition,
        triggeringEventSchemaVersion: 1,
        triggeringOccurredAt: occurredAt,
        triggeringEventPayload: payload,
        origin: {
          kind: "workflow",
          workflowId: plan.workflowId,
          workflowGeneration: plan.workflowGeneration,
        },
        triggeringEventType: materializationEventType,
      } satisfies MaterializationProjectionInputV1);
    }
    const materializationRequired = this.#materializationRequired(workflow);
    const baseStatus = sessionEndGenerationStatusV2({
      current: workflow,
      priorRootState: workflow.state === "suspended" ? "suspended" : "active",
      workflowGeneration: workflow.generation,
      triggeringEventPosition: workflow.triggeringEventPosition,
      phase: nextPhase,
      evidenceWindowState: "sealed",
      materializationRequired,
      clearFrozenGroup: false,
    });
    const status = Object.freeze({
      ...(baseStatus as unknown as Record<string, unknown>),
      validationPlansReady: true,
      qualityScore,
      safeFailureCode,
    }) as unknown as SessionEndPhaseResultV2["status"];
    const publicResult = Object.freeze({
      resultVersion: 2,
      action: effectiveAction.action,
      progressed: true,
      previousPhase: expectedPhase,
      status,
    }) as SessionEndPhaseResultV2;
    const presenting = Object.freeze({
      actorRole: context.binding.actorRole,
      clientInstanceId: context.binding.clientInstanceId,
    });
    const replayExpectation: Extract<LifecycleReplayExpectation, { kind: "internal-workflow" }> = Object.freeze({
      kind: "internal-workflow",
      workflowId: plan.workflowId,
      workflowGeneration: BigInt(plan.workflowGeneration),
      plannedWorkId: plan.plannedWorkId,
      authorizationSessionId: rootSessionId,
      targetSessionId: rootSessionId,
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
      authorizationSessionId: rootSessionId,
      targetSessionId: rootSessionId,
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
    const plannedWitness = buildLifecycleIntentWitness(plan, assertions);
    const execution = this.#commandStore.execute<SessionEndPhaseResultV2>({
      context,
      commandId: plan.commandId,
      idempotencyKey: plan.idempotencyKey,
      commandType: plan.commandType,
      candidateIntentHash: plannedWitness.intentHash,
      authoritativeIntentHash: plannedWitness.intentHash,
      semanticCommand: plan,
      capabilityKind: null,
      capabilityGeneration: null,
      replayExpectation,
    }, (transaction: LifecycleCommandTransaction) => {
      const readWorkflow = transaction.workflows.read;
      if (typeof readWorkflow !== "function") {
        throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
      }
      const currentWorkflow = readWorkflow(
        context.binding.projectId,
        plan.workflowId,
      );
      if (currentWorkflow === null
        || currentWorkflow.workflowId !== workflow.workflowId
        || currentWorkflow.sessionId !== rootSessionId
        || currentWorkflow.generation !== workflow.generation
        || currentWorkflow.phase !== expectedPhase
        || currentWorkflow.coordinatorOwnerId !== plan.claim.claimOwnerId
        || currentWorkflow.coordinatorClaimToken !== BigInt(plan.claim.claimToken)
        || currentWorkflow.coordinatorClaimExpiresAt !== plan.claim.claimExpiresAt) {
        throw new LifecycleError("SESSION_END_INCOMPLETE");
      }
      const currentRoot = this.#authority.get(
        this.#connection,
        context.binding.projectId,
        rootSessionId,
      );
      if (currentRoot === null) throw new LifecycleError("SESSION_NOT_FOUND");
      const currentAggregate = this.#authority.requireFoldMatch(this.#connection, currentRoot);
      if (currentRoot.authorityCommitment !== root.authorityCommitment
        || currentRoot.authorityEventPosition !== root.authorityEventPosition
        || currentAggregate.streamVersion !== aggregate.streamVersion
        || currentAggregate.eventPosition !== aggregate.eventPosition) {
        throw new LifecycleError("EVENT_CONFLICT");
      }
      const checkpoint = this.#assertTerminalFreshness(
        context,
        transaction,
        currentWorkflow,
        currentRoot,
        currentAggregate,
      );
      if (effectiveAction.action === "record-verification-failed"
        || effectiveAction.action === "record-verification-passed") {
        this.#assertTerminalValidationResults(
          transaction,
          context,
          currentWorkflow,
          currentRoot,
          checkpoint,
          effectiveAction,
        );
      }
      if (effectiveAction.action === "append-terminal-completion"
        && (currentAggregate.kind !== "root"
          || currentAggregate.verificationPassedEventPosition === null
          || effectiveAction.verificationEventPosition
            !== currentAggregate.verificationPassedEventPosition.toString()
          || currentAggregate.verificationPassedEventPosition >= eventPosition)) {
        throw new LifecycleError("SESSION_END_INCOMPLETE");
      }
      return {
      append: {
        context,
        commandId: plan.commandId,
        idempotencyKey: plan.idempotencyKey,
        commandType: plan.commandType,
        correlationId: aggregate.correlationId,
        agentId: plan.agentId,
        expectedStreamVersion: aggregate.streamVersion,
        streamId: root.streamId,
        streamType: "session",
        events: [{
          eventType,
          eventSchemaVersion: 1,
          occurredAt,
          visibilityScope: "session",
          sessionId: rootSessionId,
          confidence: "high",
          verificationStatus: "verified",
          payload,
          sourceRefs: [],
          evidenceRefs: [],
          evidenceDigests: [],
        }],
        outbox: preparedMaterialization === undefined
          ? []
          : [preparedMaterialization.pendingOutbox],
        publicResponse: publicResult,
      },
      authorizationRecord,
      beforeAppend: (planned) => {
        const trigger = planned.events[0];
        if (planned.events.length !== 1 || trigger?.globalPosition !== eventPosition) {
          throw new LifecycleError("INTEGRITY_FAILURE");
        }
        if (preparedMaterialization !== undefined) {
          materializationQueue?.assertPlanned(preparedMaterialization, trigger);
        }
      },
      afterAppend: (committed, currentTransaction) => {
        const trigger = committed.events[0];
        if (
          committed.events.length !== 1
          || trigger === undefined
          || trigger.globalPosition !== eventPosition
          || trigger.eventType !== eventType
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        const authorityNext = eventType === "SessionEnded"
          ? (() => {
              const provisional = Object.freeze({
                ...root,
                semanticState: "ended" as const,
                authorityEventPosition: eventPosition,
                terminalEventPosition: eventPosition,
                terminalEventType: "SessionEnded" as const,
                terminalAt: trigger.recordedAt,
                updatedAt: trigger.recordedAt,
              });
              return authorityMutation(provisional, {
                authorityCommitment: authorityCommitment(committedAuthority(provisional)),
              });
            })()
          : authorityMutation(root, {
              authorityEventPosition: eventPosition,
              updatedAt: trigger.recordedAt,
            });
        if (!this.#authority.compareAndSwap(this.#connection, {
          projectId: root.projectId,
          sessionId: root.sessionId,
          expectedState: "ending",
          expectedOwnerGeneration: root.ownerGeneration,
          expectedChildCapabilityGeneration: null,
          expectedAuthorityCommitment: root.authorityCommitment,
          next: authorityNext,
        })) throw new LifecycleError("SESSION_HANDLE_STALE");
        const advance = currentTransaction.workflows.advanceEventfulPhase;
        if (typeof advance !== "function" || !advance({
          projectId: workflow.projectId,
          workflowId: workflow.workflowId,
          workflowGeneration: workflow.generation,
          ownerId: plan.claim.claimOwnerId,
          claimToken: BigInt(plan.claim.claimToken),
          expectedPhase,
          nextPhase,
          eventPosition,
          resultJson: canonicalJson(publicResult),
          now: trigger.recordedAt,
        })) throw new LifecycleError("EVENT_CONFLICT");
        if (preparedMaterialization !== undefined) {
          materializationQueue?.assertCommitted(preparedMaterialization, trigger);
        }
      },
      };
    });
    return execution.publicResult;
  }

  #assertTerminalFreshness(
    context: ProjectContext,
    transaction: LifecycleCommandTransaction,
    workflow: SessionEndWorkflowRecordV1,
    root: SessionAuthorityRecord,
    aggregate: SessionAggregateState,
  ): Checkpoint {
    if (root.latestCheckpointId === null
      || root.latestCheckpointEventPosition === null
      || root.latestCheckpointFingerprint === null
      || workflow.evidenceFrozenCheckpointEventPosition === null
      || workflow.evidenceFrozenGeneration !== workflow.generation
      || workflow.finalEndingScopeBindingsJson === null
      || aggregate.kind !== "root"
      || aggregate.state !== "ending") {
      throw new LifecycleError("SESSION_SOURCE_STATE_CONFLICT");
    }
    if (root.latestCheckpointEventPosition !== workflow.evidenceFrozenCheckpointEventPosition) {
      throw new LifecycleError("SESSION_SOURCE_STATE_CONFLICT");
    }
    const checkpoint = this.#authority.requireCheckpointAtEventPosition(this.#connection, {
      projectId: root.projectId as ProjectContext["binding"]["projectId"],
      sessionId: root.sessionId as SessionId,
      checkpointId: root.latestCheckpointId as CheckpointId,
      checkpointEventPosition: workflow.evidenceFrozenCheckpointEventPosition,
    });
    const checkpointBytes = Buffer.from(
      `project-memory/checkpoint/v${checkpoint.checkpointVersion}\n${canonicalJson(checkpoint)}`,
      "utf8",
    );
    let fingerprint: string;
    try {
      fingerprint = createHash("sha256").update(checkpointBytes).digest("hex");
    } finally {
      checkpointBytes.fill(0);
    }
    if (checkpoint.checkpointId !== root.latestCheckpointId
      || checkpoint.checkpointEventPosition !== workflow.evidenceFrozenCheckpointEventPosition.toString()
      || root.latestCheckpointFingerprint !== fingerprint) {
      throw new LifecycleError("SESSION_SOURCE_STATE_CONFLICT");
    }

    let frozenScope: readonly FinalEndingScopeBindingV1[];
    try {
      const parsed = JSON.parse(workflow.finalEndingScopeBindingsJson) as unknown;
      frozenScope = decodeFinalEndingScopeBindingsV1(parsed);
      if (canonicalJson(frozenScope) !== workflow.finalEndingScopeBindingsJson) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
    } catch (error) {
      if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") throw error;
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if (canonicalJson(this.#endingScopeBindings(root)) !== canonicalJson(frozenScope)) {
      throw new LifecycleError("SESSION_SOURCE_STATE_CONFLICT");
    }

    const coverage = (transaction as unknown as {
      readonly coverage?: {
        readonly assertQuickHealthy?: (sessionIds: readonly SessionId[]) => void;
        readonly snapshotV2?: (sessionId: SessionId, baseEventPosition: bigint) => unknown;
      };
    }).coverage;
    const coverageSessions = Object.freeze([
      root.sessionId as SessionId,
      ...frozenScope.map((binding) => binding.childSessionId),
    ]);
    if (coverage !== undefined && typeof coverage.assertQuickHealthy === "function") {
      coverage.assertQuickHealthy(coverageSessions);
    }
    if (coverage !== undefined && typeof coverage.snapshotV2 === "function") {
      const observedCoverage = coverage.snapshotV2(
        root.sessionId as SessionId,
        BigInt(checkpoint.baseEventPosition),
      );
      if (canonicalJson(observedCoverage) !== canonicalJson(checkpoint.evidenceCoverage)) {
        throw new LifecycleError("SESSION_END_COVERAGE_CHANGED");
      }
    }
    if (this.#sourceStateProvider !== null && this.#sourceStateScopes !== null) {
      const scope = this.#sourceStateScopes.resolve(this.#connection, context);
      const observedSourceState = this.#sourceStateProvider.captureForFinalization(context, scope);
      if (canonicalJson(observedSourceState) !== canonicalJson(checkpoint.sourceState)) {
        throw new LifecycleError("SESSION_SOURCE_STATE_CONFLICT");
      }
    }
    return checkpoint;
  }

  #assertTerminalValidationResults(
    transaction: LifecycleCommandTransaction,
    context: ProjectContext,
    workflow: SessionEndWorkflowRecordV1,
    root: SessionAuthorityRecord,
    checkpoint: Checkpoint,
    action: Extract<
      InternalRootWorkflowPhasePlan["plannedAction"],
      { readonly action: "record-verification-failed" | "record-verification-passed" }
    >,
  ): readonly ValidationResultV1[] {
    const validation = (transaction as unknown as {
      readonly validation?: {
        readonly list?: (input: {
          readonly projectId: string;
          readonly workflowId: string;
          readonly workflowGeneration: number;
        }) => readonly ValidationResultV1[];
      };
    }).validation;
    if (validation === undefined || typeof validation.list !== "function") {
      throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
    }
    if (workflow.validationAttemptPlanGeneration !== workflow.generation
      || workflow.validationAttemptPlansJson === null) {
      throw new LifecycleError("SESSION_VALIDATION_RESULT_INVALID");
    }
    const readPersistedPlans = transaction.workflows.readPersistedValidationAttemptPlansV1;
    if (typeof readPersistedPlans !== "function") {
      throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
    }
    const persisted = readPersistedPlans(
      workflow.projectId,
      workflow.workflowId,
    );
    if (persisted === null || persisted.workflowGeneration !== workflow.generation) {
      throw new LifecycleError("SESSION_VALIDATION_RESULT_INVALID");
    }
    const expectedResultIds = persisted.plans.map((plan) => plan.resultId);
    if (canonicalJson(expectedResultIds) !== canonicalJson(action.validationResultIds)) {
      throw new LifecycleError("SESSION_VALIDATION_RESULT_INVALID");
    }
    const results = validation.list({
      projectId: workflow.projectId,
      workflowId: workflow.workflowId,
      workflowGeneration: workflow.generation,
    });
    if (!Array.isArray(results) || results.length !== expectedResultIds.length) {
      throw new LifecycleError("SESSION_VALIDATION_RESULT_INVALID");
    }
    const byId = new Map(results.map((result) => [result.resultId, result] as const));
    if (byId.size !== results.length) throw new LifecycleError("INTEGRITY_FAILURE");
    const policyState = hydrateSessionEndEffectiveStateV1(this.#connection, {
      projectId: workflow.projectId,
      workflowId: workflow.workflowId,
      workflowGeneration: workflow.generation,
      sessionId: workflow.sessionId,
      eventPosition: readEffectiveStateSourceEventPositionV1(this.#connection, {
        projectId: workflow.projectId,
        workflowId: workflow.workflowId,
        workflowGeneration: workflow.generation,
      }),
    });
    const coverageOnlyTerminalAction = classifyCoverageOnlyVerificationTerminalActionV1(
      policyState.effectiveState.effectivePolicy,
      action,
    );
    for (const resultId of expectedResultIds) {
      const result = byId.get(resultId);
      if (result === undefined
        || result.projectId !== root.projectId
        || result.vaultId !== context.binding.vaultId
        || result.storeId !== context.binding.storeId
        || result.workspaceId !== context.binding.workspaceId
        || result.sessionId !== root.sessionId
        || result.workflowId !== workflow.workflowId
        || result.workflowGeneration !== workflow.generation
        || result.finalCheckpointId !== checkpoint.checkpointId
        || result.finalCheckpointFingerprint !== root.latestCheckpointFingerprint
        || result.fresh !== true
        || canonicalJson(result.sourceStateAtCompletion) !== canonicalJson(checkpoint.sourceState)) {
        throw new LifecycleError("SESSION_VALIDATION_RESULT_INVALID");
      }
      if (action.action === "record-verification-passed"
        && (result.status !== "pass" || result.exitClassification !== "passed")) {
        throw new LifecycleError("SESSION_VALIDATION_RESULT_INVALID");
      }
    }
    if (action.action === "record-verification-passed") {
      if (action.qualityScore < policyState.effectiveState.effectivePolicy.qualityThreshold) {
        throw new LifecycleError("SESSION_VALIDATION_RESULT_INVALID");
      }
      const requiredProfiles = policyState.effectiveState.effectivePolicy.profiles
        .filter((profile) => profile.required)
        .map((profile) => `${profile.profileId}\u0000${profile.profileVersion}`);
      for (const profile of requiredProfiles) {
        if (!results.some((result) =>
          `${result.profileId}\u0000${result.profileVersion}` === profile
          && result.status === "pass")) {
          throw new LifecycleError("SESSION_VALIDATION_RESULT_INVALID");
        }
      }
    } else if (
      coverageOnlyTerminalAction !== "coverage-incomplete"
      && results.every((result) => result.status === "pass")
    ) {
      throw new LifecycleError("SESSION_VALIDATION_RESULT_INVALID");
    }
    return results;
  }

  #materializationRequired(workflow: SessionEndWorkflowRecordV1): boolean {
    if (workflow.resultJson !== null) {
      try {
        const parsed = JSON.parse(workflow.resultJson) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const source = (parsed as Record<string, unknown>).status;
          const status = typeof source === "object" && source !== null && !Array.isArray(source)
            ? source as Record<string, unknown>
            : parsed as Record<string, unknown>;
          if (typeof status.materializationRequired === "boolean") return status.materializationRequired;
        }
      } catch {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
    }
    return true;
  }

  #terminalMaterializationQuery(
    workflow: SessionEndWorkflowRecordV1,
  ): ExactPlannedRevisionQuery {
    const root = this.#authority.get(this.#connection, workflow.projectId, workflow.sessionId);
    if (root === null) throw new LifecycleError("SESSION_NOT_FOUND");
    if (
      root.sessionKind !== "root"
      || root.semanticState !== "ended"
      || root.terminalEventType !== "SessionEnded"
      || root.terminalEventPosition === null
      || root.terminalEventPosition < 1n
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const aggregate = this.#authority.requireFoldMatch(this.#connection, root);
    if (aggregate.kind !== "root" || aggregate.state !== "ended") {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    return {
      projectId: workflow.projectId as ProjectContext["binding"]["projectId"],
      sessionId: workflow.sessionId as SessionId,
      artifactKind: "compatibility-session-log",
      materializationRevision: root.terminalEventPosition,
      triggeringEventPosition: root.terminalEventPosition,
      origin: {
        kind: "workflow",
        workflowId: workflow.workflowId as WorkflowId,
        workflowGeneration: workflow.generation,
      },
      triggeringEventType: "SessionEnded",
    };
  }

  #confirmCompletedMaterialization(
    input: SessionEndCoordinatorDriveInput,
    claim: SessionEndWorkflowClaimV1,
    workflow: SessionEndWorkflowRecordV1,
  ): SessionEndPhaseResultV2 {
    if (
      workflow.phase !== "completion-appended"
      || claim.phase !== "completion-appended"
      || !this.#materializationRequired(workflow)
    ) throw new LifecycleError("SESSION_END_INCOMPLETE");
    const exactQuery = this.#terminalMaterializationQuery(workflow);
    const result = this.#operationalStore.execute({
      kind: "workflow",
      projectId: claim.projectId,
      workflowId: claim.workflowId as WorkflowId,
      workflowGeneration: BigInt(claim.workflowGeneration),
      operation: "advance-eventless",
      ownerId: claim.ownerId,
      claimToken: claim.claimToken,
    }, (transaction) => {
      const current = transaction.workflows.read(claim.projectId, claim.workflowId);
      if (current === null) throw new LifecycleError("SESSION_NOT_FOUND");
      if (
        current.phase !== "completion-appended"
        || current.workflowId !== workflow.workflowId
        || current.sessionId !== workflow.sessionId
        || current.generation !== workflow.generation
      ) throw new LifecycleError("EVENT_CONFLICT");
      const planned = transaction.outboxPlans.assertExactPlannedRevision(exactQuery);
      const materializations = transaction.materializations;
      if (materializations === undefined) {
        throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
      }
      if (!materializations.isCompleted({
        projectId: planned.projectId,
        targetKey: planned.targetKey,
        materializationRevision: planned.materializationRevision,
      })) return { progressed: false };
      const status = sessionEndGenerationStatusV2({
        current,
        priorRootState: current.state === "suspended" ? "suspended" : "active",
        workflowGeneration: current.generation,
        triggeringEventPosition: current.triggeringEventPosition,
        phase: "completed-materialization-confirmed",
        evidenceWindowState: "sealed",
        materializationRequired: true,
        clearFrozenGroup: false,
      });
      const next = Object.freeze({
        resultVersion: 2,
        action: "confirm-completed-materialization" as const,
        progressed: true,
        previousPhase: "completion-appended" as const,
        status,
      }) as SessionEndPhaseResultV2;
      if (!transaction.workflows.advanceEventlessPhase({
        projectId: current.projectId,
        workflowId: current.workflowId,
        workflowGeneration: current.generation,
        ownerId: claim.ownerId,
        claimToken: claim.claimToken,
        expectedPhase: "completion-appended",
        nextPhase: "completed-materialization-confirmed",
        observedNowMs: input.observedNowMs,
        resultJson: canonicalJson(next),
      })) throw new LifecycleError("EVENT_CONFLICT");
      return next;
    });
    if (!(result.publicResult as { readonly progressed?: unknown }).progressed) {
      const current = new SessionEndWorkflowRepository(this.#connection).read(
        workflow.projectId,
        workflow.workflowId,
      );
      if (current === null) throw new LifecycleError("SESSION_NOT_FOUND");
      return this.#status(current, false);
    }
    return result.publicResult as unknown as SessionEndPhaseResultV2;
  }

  #completeAfterMaterialization(
    input: SessionEndCoordinatorDriveInput,
    claim: SessionEndWorkflowClaimV1,
    workflow: SessionEndWorkflowRecordV1,
  ): SessionEndPhaseResultV2 {
    if (
      workflow.phase !== "completed-materialization-confirmed"
      || claim.phase !== "completed-materialization-confirmed"
      || !this.#materializationRequired(workflow)
    ) throw new LifecycleError("SESSION_END_INCOMPLETE");
    const result = this.#operationalStore.execute({
      kind: "workflow",
      projectId: claim.projectId,
      workflowId: claim.workflowId as WorkflowId,
      workflowGeneration: BigInt(claim.workflowGeneration),
      operation: "advance-eventless",
      ownerId: claim.ownerId,
      claimToken: claim.claimToken,
    }, (transaction) => {
      const current = transaction.workflows.read(claim.projectId, claim.workflowId);
      if (current === null) throw new LifecycleError("SESSION_NOT_FOUND");
      if (
        current.phase !== "completed-materialization-confirmed"
        || current.workflowId !== workflow.workflowId
        || current.sessionId !== workflow.sessionId
        || current.generation !== workflow.generation
      ) throw new LifecycleError("EVENT_CONFLICT");
      const status = sessionEndGenerationStatusV2({
        current,
        priorRootState: current.state === "suspended" ? "suspended" : "active",
        workflowGeneration: current.generation,
        triggeringEventPosition: current.triggeringEventPosition,
        phase: "completed",
        evidenceWindowState: "sealed",
        materializationRequired: true,
        clearFrozenGroup: false,
      });
      const next = Object.freeze({
        resultVersion: 2,
        action: "complete-after-materialization" as const,
        progressed: true,
        previousPhase: "completed-materialization-confirmed" as const,
        status,
      }) as SessionEndPhaseResultV2;
      if (!transaction.workflows.advanceEventlessPhase({
        projectId: current.projectId,
        workflowId: current.workflowId,
        workflowGeneration: current.generation,
        ownerId: claim.ownerId,
        claimToken: claim.claimToken,
        expectedPhase: "completed-materialization-confirmed",
        nextPhase: "completed",
        observedNowMs: input.observedNowMs,
        resultJson: canonicalJson(next),
      })) throw new LifecycleError("EVENT_CONFLICT");
      return next;
    });
    return result.publicResult as unknown as SessionEndPhaseResultV2;
  }

  #completeWithoutMaterialization(
    input: SessionEndCoordinatorDriveInput,
    claim: SessionEndWorkflowClaimV1,
    workflow: SessionEndWorkflowRecordV1,
  ): SessionEndPhaseResultV2 {
    if (this.#materializationRequired(workflow)) return this.#status(workflow, false);
    const result = this.#operationalStore.execute({
      kind: "workflow",
      projectId: claim.projectId,
      workflowId: claim.workflowId as WorkflowId,
      workflowGeneration: BigInt(claim.workflowGeneration),
      operation: "advance-eventless",
      ownerId: claim.ownerId,
      claimToken: claim.claimToken,
    }, (transaction) => {
      const current = transaction.workflows.read(claim.projectId, claim.workflowId);
      if (current === null) throw new LifecycleError("SESSION_NOT_FOUND");
      const base = sessionEndGenerationStatusV2({
        current,
        priorRootState: current.state === "suspended" ? "suspended" : "active",
        workflowGeneration: current.generation,
        triggeringEventPosition: current.triggeringEventPosition,
        phase: "completed",
        evidenceWindowState: "sealed",
        materializationRequired: false,
        clearFrozenGroup: false,
      });
      const next = Object.freeze({
        resultVersion: 2,
        action: "complete-without-materialization" as const,
        progressed: true,
        previousPhase: "completion-appended" as const,
        status: base,
      }) as SessionEndPhaseResultV2;
      if (!transaction.workflows.advanceEventlessPhase({
        projectId: current.projectId,
        workflowId: current.workflowId,
        workflowGeneration: current.generation,
        ownerId: claim.ownerId,
        claimToken: claim.claimToken,
        expectedPhase: "completion-appended",
        nextPhase: "completed",
        observedNowMs: input.observedNowMs,
        resultJson: canonicalJson(next),
      })) throw new LifecycleError("EVENT_CONFLICT");
      return next;
    });
    return result.publicResult as unknown as SessionEndPhaseResultV2;
  }

  #executeRoot(
    context: ProjectContext,
    plan: InternalRootWorkflowPhasePlan,
  ): SessionEndPhaseResultV2 {
    const checkpointService = this.#checkpoint;
    const sourceStateScopes = this.#sourceStateScopes;
    if (checkpointService === null || sourceStateScopes === null) {
      throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
    }
    const action = plan.plannedAction;
    if (action.action !== "prepare-final-checkpoint-and-queue-ending") {
      throw new LifecycleError("LIFECYCLE_OPERATION_UNAVAILABLE");
    }
    const planningWorkflow = new SessionEndWorkflowRepository(this.#connection).read(
      context.binding.projectId,
      plan.workflowId,
    );
    if (planningWorkflow === null
      || planningWorkflow.phase !== "children-resolved"
      || planningWorkflow.generation !== plan.workflowGeneration) {
      throw new LifecycleError("SESSION_END_INCOMPLETE");
    }
    const rootSessionId = planningWorkflow.sessionId as SessionId;
    const presenting = Object.freeze({
      actorRole: context.binding.actorRole,
      clientInstanceId: context.binding.clientInstanceId,
    });
    const replayExpectation: Extract<LifecycleReplayExpectation, { kind: "internal-workflow" }> = Object.freeze({
      kind: "internal-workflow",
      workflowId: plan.workflowId,
      workflowGeneration: BigInt(plan.workflowGeneration),
      plannedWorkId: plan.plannedWorkId,
      authorizationSessionId: rootSessionId,
      targetSessionId: rootSessionId,
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
      authorizationSessionId: rootSessionId,
      targetSessionId: rootSessionId,
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
    const plannedWitness = buildLifecycleIntentWitness(plan, assertions);
    const result = this.#commandStore.execute<SessionEndPhaseResultV2>({
      context,
      commandId: plan.commandId,
      idempotencyKey: plan.idempotencyKey,
      commandType: plan.commandType,
      candidateIntentHash: plannedWitness.intentHash,
      authoritativeIntentHash: plannedWitness.intentHash,
      semanticCommand: plan,
      capabilityKind: null,
      capabilityGeneration: null,
      replayExpectation,
    }, (transaction: LifecycleCommandTransaction) => {
      const root = this.#authority.get(
        this.#connection,
        context.binding.projectId,
        rootSessionId,
      );
      if (root === null) throw new LifecycleError("SESSION_NOT_FOUND");
      const aggregate = this.#authority.requireFoldMatch(this.#connection, root);
      if (root.sessionKind !== "root"
        || root.parentSessionId !== null
        || root.semanticState !== "ending"
        || aggregate.kind !== "root"
        || aggregate.state !== "ending") {
        throw new LifecycleError("SESSION_END_INCOMPLETE");
      }
      const workflow = new SessionEndWorkflowRepository(this.#connection).read(
        context.binding.projectId,
        plan.workflowId,
      );
      if (workflow === null
        || workflow.sessionId !== root.sessionId
        || workflow.phase !== "children-resolved"
        || workflow.generation !== plan.workflowGeneration
        || workflow.coordinatorOwnerId !== plan.claim.claimOwnerId
        || workflow.coordinatorClaimToken !== BigInt(plan.claim.claimToken)
        || workflow.coordinatorClaimExpiresAt !== plan.claim.claimExpiresAt) {
        throw new LifecycleError("SESSION_END_INCOMPLETE");
      }
      this.#proveResolved(workflow);
      const endingScopeBindings = this.#endingScopeBindings(root);
      const draft = action.finalCheckpointDraft;
      const checkpointCommand = Object.freeze({
        commandType: "record-checkpoint" as const,
        commandId: plan.commandId,
        idempotencyKey: plan.idempotencyKey,
        agentId: plan.agentId,
        expectedProjectId: context.binding.projectId,
        expectedVaultId: context.binding.vaultId,
        expectedWorkspaceId: context.binding.workspaceId,
        expectedBranchRef: context.workspace.kind === "git" ? context.workspace.branchRef : null,
        sessionId: root.sessionId as SessionId,
        expectedStreamVersion: aggregate.streamVersion.toString(),
        expectedBaseEventPosition: null,
        draft,
      }) as RecordCheckpointCommandV2 | RecordCheckpointCommandV3;
      const workflowClaim: WorkflowClaimAssertionV1 = Object.freeze({
        workflowId: plan.workflowId,
        workflowGeneration: plan.workflowGeneration,
        claimOwnerId: plan.claim.claimOwnerId,
        claimToken: plan.claim.claimToken,
        claimExpiresAt: plan.claim.claimExpiresAt,
      });
      this.#checkpointScopes.set(transaction as object, Object.freeze({
        context,
        sourceStateScope: sourceStateScopes.resolve(this.#connection, context),
        authorizationRecord,
        workflowClaim,
      }));
      try {
        const prepared = checkpointService.prepareFinalWorkflowPhase(transaction, {
          command: checkpointCommand,
          materializationTarget: action.materializationTarget,
          workflowClaim,
          internalCommand: {
            commandType: "internal-workflow-phase",
            agentId: plan.agentId,
          },
          finalEndingScopeBindings: endingScopeBindings,
          finalizeWorkflow: (currentTransaction, checkpoint, fingerprint, eventPosition, occurredAt) => {
            const status = sessionEndFinalCheckpointStatusV2({
              current: workflow,
              checkpointId: checkpoint.checkpointId,
              checkpointEventPosition: eventPosition,
              priorRootState: workflow.state === "suspended" ? "suspended" : "active",
            });
            const result: SessionEndPhaseResultV2 = Object.freeze({
              resultVersion: 2,
              action: "record-final-checkpoint-and-queue-ending" as const,
              progressed: true,
              previousPhase: "children-resolved" as const,
              status,
            });
            const recordFinalCheckpoint = currentTransaction.workflows.recordFinalCheckpoint;
            if (typeof recordFinalCheckpoint !== "function") {
              throw new LifecycleError("INTEGRITY_FAILURE");
            }
            recordFinalCheckpoint({
              projectId: root.projectId,
              workflowId: workflow.workflowId,
              workflowGeneration: workflow.generation,
              sessionId: root.sessionId,
              rootCommandId: plan.commandId,
              ownerId: plan.claim.claimOwnerId,
              claimToken: BigInt(plan.claim.claimToken),
              checkpointId: checkpoint.checkpointId,
              checkpointEventPosition: eventPosition,
              checkpointFingerprint: fingerprint,
              finalEndingScopeBindingsJson: canonicalJson(endingScopeBindings),
              resultJson: canonicalJson(result),
              now: occurredAt,
            });
          },
        });
        const checkpoint = prepared.action.finalCheckpoint;
        const actualCommand = Object.freeze({
          commandType: "internal-workflow-phase",
          commandId: plan.commandId,
          idempotencyKey: plan.idempotencyKey,
          agentId: plan.agentId,
          expectedProjectId: plan.expectedProjectId,
          expectedVaultId: plan.expectedVaultId,
          expectedWorkspaceId: plan.expectedWorkspaceId,
          expectedBranchRef: plan.expectedBranchRef,
          workflowId: plan.workflowId,
          workflowGeneration: plan.workflowGeneration,
          sourcePhase: plan.sourcePhase,
          plannedWorkId: plan.plannedWorkId,
          claim: plan.claim,
          action: {
            action: "record-final-checkpoint-and-queue-ending" as const,
            finalCheckpoint: checkpoint,
            materializationTarget: action.materializationTarget,
          },
        }) as unknown as InternalRootWorkflowPhaseCommand;
        const actualWitness = buildLifecycleIntentWitness(actualCommand, assertions);
        const status = sessionEndFinalCheckpointStatusV2({
          current: workflow,
          checkpointId: checkpoint.checkpointId,
          checkpointEventPosition: BigInt(checkpoint.checkpointEventPosition),
          priorRootState: workflow.state === "suspended" ? "suspended" : "active",
        });
        const finalResult: SessionEndPhaseResultV2 = Object.freeze({
          resultVersion: 2,
          action: "record-final-checkpoint-and-queue-ending" as const,
          progressed: true,
          previousPhase: "children-resolved" as const,
          status,
        });
        return {
          ...prepared.effect,
          append: Object.freeze({
            ...prepared.effect.append,
            publicResponse: finalResult,
          }),
          resolvedSemanticCommand: actualCommand,
          resolvedAuthoritativeIntentHash: actualWitness.intentHash,
        } as unknown as PreparedLifecycleCommit<SessionEndPhaseResultV2>;
      } finally {
        this.#checkpointScopes.delete(transaction as object);
      }
    });
    return result.publicResult;
  }

  #endingScopeBindings(root: SessionAuthorityRecord): readonly FinalEndingScopeBindingV1[] {
    const children = this.#authority.listChildHistoryBounded(
      this.#connection,
      root.projectId,
      root.sessionId,
      MAX_ROOT_CHILD_HISTORY_V1 + 1,
    ).filter((child) => child.terminalEventPosition === null);
    if (children.length > MAX_ROOT_CHILD_HISTORY_V1) {
      throw new LifecycleError("CHECKPOINT_CAPACITY_EXCEEDED");
    }
    const current = children.map((child) => {
      const aggregate = this.#authority.requireFoldMatch(this.#connection, child);
      const checkpoint = this.#authority.latestCheckpoint(this.#connection, child);
      if (aggregate.kind !== "child"
        || child.sessionKind !== "child"
        || child.parentSessionId !== root.sessionId
        || child.terminalEventPosition !== null
        || (aggregate.state !== "active"
          && aggregate.state !== "completion-proposed"
          && aggregate.state !== "suspended")) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      return {
        bindingVersion: 1 as const,
        bindingKind: "current-child" as const,
        childSessionId: child.sessionId as SessionId,
        childState: aggregate.state,
        lastEventPosition: aggregate.eventPosition.toString(),
        streamVersion: aggregate.streamVersion.toString(),
        checkpointId: checkpoint?.checkpointId as CheckpointId | null,
        checkpointEventPosition: checkpoint?.checkpointEventPosition ?? null,
        transferTicketId: null,
        transferTicketEventPosition: null,
      } satisfies FinalEndingScopeBindingV1;
    });
    const tickets = this.#transfers.listUnclaimedEndingScopeProjectionsBySourceRoot(
      this.#connection,
      root.projectId,
      root.sessionId,
      MAX_ROOT_CHILD_HISTORY_V1 + 1,
    );
    if (tickets.length > MAX_ROOT_CHILD_HISTORY_V1) {
      throw new LifecycleError("CHECKPOINT_CAPACITY_EXCEEDED");
    }
    const carried = tickets.map((ticket) => ({
      bindingVersion: 1 as const,
      bindingKind: "carry-forward-ticket" as const,
      childSessionId: ticket.childSessionId as SessionId,
      childState: "transferred" as const,
      lastEventPosition: ticket.lastEventPosition.toString(),
      streamVersion: ticket.streamVersion.toString(),
      checkpointId: ticket.checkpointId as CheckpointId,
      checkpointEventPosition: ticket.checkpointEventPosition.toString(),
      transferTicketId: ticket.transferTicketId as TransferTicketId,
      transferTicketEventPosition: ticket.transferTicketEventPosition.toString(),
    } satisfies FinalEndingScopeBindingV1));
    const sorted = [...current, ...carried].sort((left, right) => Buffer.compare(
      Buffer.from(left.childSessionId, "utf8"),
      Buffer.from(right.childSessionId, "utf8"),
    ));
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index - 1]!.childSessionId === sorted[index]!.childSessionId) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
    }
    if (sorted.length > MAX_ROOT_CHILD_HISTORY_V1) {
      throw new LifecycleError("CHECKPOINT_CAPACITY_EXCEEDED");
    }
    return Object.freeze(sorted);
  }

  #claimNext(input: SessionEndCoordinatorDriveInput): SessionEndWorkflowClaimV1 | null {
    const result = this.#operationalStore.execute({
      kind: "workflow-selection",
      projectId: input.context.binding.projectId,
      workId: `workflow-selection/${input.ownerId}`,
      operation: "claim-next",
      ownerId: input.ownerId,
    }, (transaction) => transaction.workflows.claimNext({
      projectId: input.context.binding.projectId,
      ownerId: input.ownerId,
      observedNowMs: input.observedNowMs,
      leaseDurationMs: input.leaseDurationMs,
    }) as unknown as JsonValue);
    return result.publicResult as unknown as SessionEndWorkflowClaimV1 | null;
  }

  #releaseClaim(claim: SessionEndWorkflowClaimV1): void {
    this.#operationalStore.execute({
      kind: "workflow",
      projectId: claim.projectId,
      workflowId: claim.workflowId as WorkflowId,
      workflowGeneration: BigInt(claim.workflowGeneration),
      operation: "release",
      ownerId: claim.ownerId,
      claimToken: claim.claimToken,
    }, (transaction) => transaction.workflows.release({
      projectId: claim.projectId,
      workflowId: claim.workflowId,
      workflowGeneration: claim.workflowGeneration,
      ownerId: claim.ownerId,
      claimToken: claim.claimToken,
    }));
  }

  #resolveChildren(
    input: SessionEndCoordinatorDriveInput,
    claim: SessionEndWorkflowClaimV1,
    workflow: SessionEndWorkflowRecordV1,
  ): SessionEndPhaseResultV2 {
    const result = this.#operationalStore.execute({
      kind: "workflow",
      projectId: claim.projectId,
      workflowId: claim.workflowId as WorkflowId,
      workflowGeneration: BigInt(claim.workflowGeneration),
      operation: "advance-eventless",
      ownerId: claim.ownerId,
      claimToken: claim.claimToken,
    }, (transaction) => {
      this.#proveResolved(workflow);
      const next = this.#status(workflow, true);
      const progressed = transaction.workflows.advanceEventlessPhase({
        projectId: claim.projectId,
        workflowId: claim.workflowId as WorkflowId,
        workflowGeneration: claim.workflowGeneration,
        expectedPhase: "requested",
        nextPhase: "children-resolved",
        ownerId: claim.ownerId,
        claimToken: claim.claimToken,
        observedNowMs: input.observedNowMs,
        resultJson: canonicalJson(next),
      });
      if (progressed) return next;
      const current = new SessionEndWorkflowRepository(this.#connection).read(
        claim.projectId,
        claim.workflowId,
      );
      if (current === null) throw new LifecycleError("INTEGRITY_FAILURE");
      return this.#status(current, false);
    });
    return result.publicResult;
  }

  #proveResolved(workflow: SessionEndWorkflowRecordV1): void {
    const children = this.#authority.listChildHistoryBounded(
      this.#connection,
      workflow.projectId,
      workflow.sessionId,
      MAX_ROOT_CHILD_HISTORY_V1 + 1,
    );
    const tickets = this.#transfers.listBySourceRoot(
      this.#connection,
      workflow.projectId,
      workflow.sessionId,
      MAX_ROOT_CHILD_HISTORY_V1 + 1,
    );
    if (children.length > MAX_ROOT_CHILD_HISTORY_V1 || tickets.length > MAX_ROOT_CHILD_HISTORY_V1) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    for (let index = 1; index < children.length; index += 1) {
      if (Buffer.compare(
        Buffer.from(children[index - 1]!.sessionId, "utf8"),
        Buffer.from(children[index]!.sessionId, "utf8"),
      ) >= 0) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
    }
    for (let index = 1; index < tickets.length; index += 1) {
      const previous = tickets[index - 1]!;
      const current = tickets[index]!;
      const byChild = Buffer.compare(
        Buffer.from(previous.sourceChildSessionId, "utf8"),
        Buffer.from(current.sourceChildSessionId, "utf8"),
      );
      if (byChild > 0 || (byChild === 0
        && Buffer.compare(
          Buffer.from(previous.transferTicketId, "utf8"),
          Buffer.from(current.transferTicketId, "utf8"),
        ) >= 0)) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
    }
    if (selectEligibleChild(children) !== null) throw new LifecycleError("EVENT_CONFLICT");
    const childrenById = new Map<string, SessionAuthorityRecord>();
    for (const child of children) {
      if (child.projectId !== workflow.projectId
        || child.sessionKind !== "child"
        || child.parentSessionId !== workflow.sessionId
        || childrenById.has(child.sessionId)) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const events = this.#authority.loadEvents(this.#connection, child);
      const aggregate = this.#authority.requireFoldMatch(this.#connection, child);
      const fork = events.find((event) => event.eventType === "SessionForked");
      if (fork === undefined || fork.sessionId !== child.sessionId
        || fork.parentSessionId !== workflow.sessionId
        || fork.payload.parentSessionId !== workflow.sessionId) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const last = events.at(-1);
      if (last === undefined) throw new LifecycleError("INTEGRITY_FAILURE");
      if (child.semanticState === "transferred") {
        if (aggregate.kind !== "child"
          || aggregate.state !== "transferred"
          || child.terminalEventPosition === null
          || last.eventType !== "ChildWorkTransferCreated"
          || BigInt(last.globalPosition) !== child.terminalEventPosition
          || child.terminalEventType !== "ChildWorkTransferCreated") {
          throw new LifecycleError("INTEGRITY_FAILURE");
        }
      } else if (child.semanticState === "completed") {
        if (aggregate.kind !== "child"
          || aggregate.state !== "completed"
          || child.terminalEventPosition === null
          || last.eventType !== "ChildSessionCompleted"
          || BigInt(last.globalPosition) !== child.terminalEventPosition
          || child.terminalEventType !== "ChildSessionCompleted") {
          throw new LifecycleError("INTEGRITY_FAILURE");
        }
      } else if (child.terminalEventPosition !== null
        || child.terminalEventType !== null
        || aggregate.kind !== "child"
        || (aggregate.state !== "active"
          && aggregate.state !== "completion-proposed"
          && aggregate.state !== "suspended")) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      childrenById.set(child.sessionId, child);
    }
    const transferred = children.filter((child) => child.semanticState === "transferred");
    const ticketsByChild = new Map<string, number>();
    for (const ticket of tickets) {
      if (ticket.projectId !== workflow.projectId || ticket.sourceParentSessionId !== workflow.sessionId) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      ticketsByChild.set(ticket.sourceChildSessionId, (ticketsByChild.get(ticket.sourceChildSessionId) ?? 0) + 1);
      const source = childrenById.get(ticket.sourceChildSessionId);
      if (source === undefined || source.semanticState !== "transferred"
        || source.terminalEventPosition !== ticket.createdEventPosition) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      this.#proveTicket(workflow, ticket, source);
      const claimed = [
        ticket.claimedByRootSessionId,
        ticket.claimedChildSessionId,
        ticket.claimedEventPosition,
        ticket.claimedAtMs,
      ];
      if (claimed.some((value) => value === null) && claimed.some((value) => value !== null)) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      if (claimed.every((value) => value !== null)) {
        this.#proveClaimWitness(ticket);
      }
    }
    for (const child of transferred) {
      if ((ticketsByChild.get(child.sessionId) ?? 0) !== 1) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
    }
  }

  #proveTicket(
    workflow: SessionEndWorkflowRecordV1,
    ticket: ChildTransferTicketRecord,
    source: SessionAuthorityRecord,
  ): void {
    const events = this.#authority.loadEvents(this.#connection, source);
    const transferEvents = events.filter((event): event is Extract<
      LifecycleEventCodecResult,
      { readonly eventType: "ChildWorkTransferCreated" }
    > => event.eventType === "ChildWorkTransferCreated"
      && BigInt(event.globalPosition) === ticket.createdEventPosition);
    if (transferEvents.length !== 1) throw new LifecycleError("INTEGRITY_FAILURE");
    const transfer = transferEvents[0]!;
    if (transfer.parentSessionId !== ticket.sourceParentSessionId
      || transfer.payload.transferTicketId !== ticket.transferTicketId
      || transfer.payload.checkpointId !== ticket.checkpointId
      || transfer.payload.authorityCommitment !== source.authorityCommitment
      || transfer.authorityCommitment !== source.authorityCommitment) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    const checkpointEvents = events.filter((event) => event.eventType === "SessionCheckpointRecorded"
      && event.payload.checkpoint.checkpointId === ticket.checkpointId
      && BigInt(event.globalPosition) === BigInt(event.payload.checkpointEventPosition));
    if (checkpointEvents.length !== 1
      || checkpointEvents[0]!.sessionId !== source.sessionId
      || checkpointEvents[0]!.parentSessionId !== source.parentSessionId
      || BigInt(checkpointEvents[0]!.globalPosition) > ticket.createdEventPosition) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if (transfer.eventSchemaVersion === 2) {
      if (!("suspensionCheckpointId" in transfer.payload)) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const suspension = events.filter((event): event is Extract<
        LifecycleEventCodecResult,
        { readonly eventType: "ChildSessionSuspended" }
      > => event.eventType === "ChildSessionSuspended"
        && event.payload.checkpointId === transfer.payload.suspensionCheckpointId
        && BigInt(event.globalPosition) < ticket.createdEventPosition);
      if (suspension.length !== 1
        || suspension[0]!.parentSessionId !== source.parentSessionId) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
    }
    const lineage = ticket.lineage;
    if (typeof lineage !== "object" || lineage === null || Array.isArray(lineage)) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if ((lineage as Record<string, unknown>).lineageKind === "session-end-carry-forward-v1") {
      const decoded = decodeSessionEndCarryForwardTicketLineageV1(lineage);
      if (decoded.workflowId !== workflow.workflowId
        || decoded.workflowGeneration !== workflow.generation
        || decoded.previousParentSessionId !== workflow.sessionId
        || decoded.previousChildSessionId !== source.sessionId
        || decoded.transferEventPosition !== ticket.createdEventPosition.toString()
        || decoded.checkpointEventPosition !== checkpointEvents[0]!.globalPosition
        || decoded.correlationId !== transfer.correlationId) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
    } else {
      const keys = [
        "previousParentSessionId",
        "previousChildSessionId",
        "correlationId",
        "transferEventPosition",
      ];
      const actual = Reflect.ownKeys(lineage);
      if (actual.length !== keys.length
        || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const record = lineage as Record<string, unknown>;
      if (record.previousParentSessionId !== workflow.sessionId
        || record.previousChildSessionId !== source.sessionId
        || record.correlationId !== transfer.correlationId
        || record.transferEventPosition !== ticket.createdEventPosition.toString()) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
    }
  }

  #proveClaimWitness(ticket: ChildTransferTicketRecord): void {
    const rootId = ticket.claimedByRootSessionId;
    const childId = ticket.claimedChildSessionId;
    const claimPosition = ticket.claimedEventPosition;
    if (rootId === null || childId === null || claimPosition === null) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    const root = this.#authority.get(this.#connection, ticket.projectId, rootId);
    const child = this.#authority.get(this.#connection, ticket.projectId, childId);
    if (root === null || child === null
      || root.sessionKind !== "root"
      || root.parentSessionId !== null
      || child.sessionKind !== "child"
      || child.parentSessionId !== root.sessionId) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    const events = this.#authority.loadEvents(this.#connection, child);
    const forks = events.filter((event): event is Extract<
      LifecycleEventCodecResult,
      { readonly eventType: "SessionForked" }
    > => event.eventType === "SessionForked"
      && event.payload.sourceTransferTicketId === ticket.transferTicketId
      && event.parentSessionId === root.sessionId);
    const claims = events.filter((event): event is Extract<
      LifecycleEventCodecResult,
      { readonly eventType: "ChildWorkTransferClaimed" }
    > => event.eventType === "ChildWorkTransferClaimed"
      && BigInt(event.globalPosition) === claimPosition
      && event.parentSessionId === root.sessionId);
    if (forks.length !== 1 || claims.length !== 1) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    const claim = claims[0]!;
    if (claim.payload.transferTicketId !== ticket.transferTicketId
      || claim.payload.previousChildSessionId !== ticket.sourceChildSessionId
      || claim.payload.previousTransferEventPosition !== ticket.createdEventPosition.toString()) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    this.#authority.requireFoldMatch(this.#connection, root);
    this.#authority.requireFoldMatch(this.#connection, child);
  }

  #childPlan(
    context: ProjectContext,
    claim: SessionEndWorkflowClaimV1,
    child: SessionAuthorityRecord,
  ): InternalCarryForwardChildPlanV1 {
    const aggregate = this.#authority.requireFoldMatch(this.#connection, child);
    const checkpoint = this.#authority.latestCheckpoint(this.#connection, child);
    if (aggregate.kind !== "child" || checkpoint === null) throw new LifecycleError("INTEGRITY_FAILURE");
    const events = this.#authority.loadEvents(this.#connection, child);
    const suspension = child.semanticState === "suspended"
      ? events.filter((event) => event.eventType === "ChildSessionSuspended").at(-1)
      : undefined;
    const plannedWorkId = createHash("sha256")
      .update(`session-end-child/v1\n${claim.workflowId}\n${claim.workflowGeneration}\n${child.sessionId}\n${child.authorityEventPosition.toString()}`, "utf8")
      .digest("hex");
    const commandId = this.#ids.uuid();
    const action: CarryForwardChildActionV1 = {
      action: "carry-forward-child" as const,
      actionVersion: 1 as const,
      rootSessionId: child.parentSessionId! as SessionId,
      childSessionId: child.sessionId as SessionId,
      expectedChildState: child.semanticState as "active" | "completion-proposed" | "suspended",
      expectedChildHeadEventPosition: aggregate.eventPosition.toString(),
      expectedChildStreamVersion: aggregate.streamVersion.toString(),
      expectedChildAuthorityCommitment: child.authorityCommitment,
      expectedChildCapabilityGeneration: child.childCapabilityGeneration?.toString() ?? "0",
      expectedSuspensionEventPosition: suspension?.eventType === "ChildSessionSuspended"
        ? suspension.globalPosition
        : null,
      checkpointId: checkpoint.checkpointId as CheckpointId,
      checkpointEventPosition: checkpoint.checkpointEventPosition,
      checkpointFingerprint: createHash("sha256")
        .update(`project-memory/checkpoint/v${checkpoint.checkpointVersion}\n${canonicalJson(checkpoint)}`, "utf8")
        .digest("hex"),
    };
    return Object.freeze({
      commandType: "internal-workflow-phase" as const,
      commandId,
      idempotencyKey: `session-end/carry-forward/${claim.workflowId}/${claim.workflowGeneration}/${child.sessionId}`,
      agentId: claim.ownerId,
      expectedProjectId: context.binding.projectId,
      expectedVaultId: context.binding.vaultId,
      expectedWorkspaceId: context.binding.workspaceId,
      expectedBranchRef: context.workspace.kind === "git" ? context.workspace.branchRef : null,
      workflowId: claim.workflowId as WorkflowId,
      workflowGeneration: claim.workflowGeneration,
      sourcePhase: "requested" as const,
      plannedWorkId,
      claim: {
        workflowId: claim.workflowId as WorkflowId,
        workflowGeneration: claim.workflowGeneration,
        claimOwnerId: claim.ownerId,
        claimToken: claim.claimToken.toString(),
        claimExpiresAt: claim.claimExpiresAt,
      },
      plannedAction: action,
    });
  }

  #status(workflow: SessionEndWorkflowRecordV1, progressed: boolean): SessionEndPhaseResultV2 {
    let status: Record<string, unknown> = {};
    if (workflow.resultJson !== null) {
      try {
        const parsed = JSON.parse(workflow.resultJson) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          status = (parsed as Record<string, unknown>).status !== undefined
            ? (parsed as Record<string, unknown>).status as Record<string, unknown>
            : parsed as Record<string, unknown>;
        }
      } catch {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
    }
    const nextPhase = progressed && workflow.phase === "requested"
      ? "children-resolved"
      : workflow.phase;
    const materializationRequired = typeof status.materializationRequired === "boolean"
      ? status.materializationRequired
      : true;
    return Object.freeze({
      resultVersion: 2,
      action: "mark-children-resolved",
      progressed,
      previousPhase: progressed ? "requested" : workflow.phase,
      status: Object.freeze({
        ...status,
        resultVersion: 2,
        sessionId: workflow.sessionId,
        workflowId: workflow.workflowId,
        workflowGeneration: workflow.generation,
        phase: nextPhase,
        priorRootState: workflow.state === "suspended" ? "suspended" : "active",
        triggeringEventPosition: workflow.triggeringEventPosition.toString(),
        finalCheckpointId: null,
        finalCheckpointEventPosition: null,
        evidenceWindow: Object.freeze({
          evidenceWindowState: workflow.evidenceWindowState ?? "sealed",
          evidenceFrozenCheckpointEventPosition: workflow.evidenceFrozenCheckpointEventPosition?.toString() ?? null,
          evidenceFrozenGeneration: workflow.evidenceFrozenGeneration,
        }),
        validationPlansReady: false,
        qualityScore: null,
        safeFailureCode: null,
        materializationRequired,
      }),
    }) as SessionEndPhaseResultV2;
  }
}
