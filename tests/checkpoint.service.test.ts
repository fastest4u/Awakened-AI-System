import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type {
  AppendCommand,
  JsonValue,
  PersistedLifecycleAuthorizationRecord,
} from "../src/orchestrator/contracts/event.js";
import { internalPhasePlannedWorkId } from "../src/orchestrator/crypto/event-hash.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import {
  decodeCheckpointDraftV1,
  decodeCheckpointDraftV2,
  decodeCheckpointV1,
} from "../src/orchestrator/lifecycle/contracts/checkpoint.js";
import type {
  InternalWorkflowExecutionPlan,
  InternalWorkflowPhaseCommand,
  InternalWorkflowPhasePlan,
  RecordCheckpointCommandV2,
  RecordCheckpointCommandV3,
} from "../src/orchestrator/lifecycle/contracts/commands.js";
import {
  LifecycleCommandStore,
  type LifecycleCommandEnvelope,
  type LifecycleCommandTransaction,
  type LifecycleEventAppendPort,
  type PreparedLifecycleCommit,
} from "../src/orchestrator/lifecycle/lifecycle-command.store.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import {
  buildLifecycleIntentWitness,
  type TrustedLifecycleIntentAssertionsV1,
} from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import type {
  EventAppendBatch,
  EventAppendReplay,
  PlannedEventAppend,
  PreparedEventAppend,
} from "../src/orchestrator/storage/event-append-transaction.js";
import type { SqliteConnection, SqliteStatement } from "../src/orchestrator/storage/sqlite-driver.js";
import {
  checkpointFixture,
  qualifiedCheckpointFixture,
} from "./support/lifecycle-fixtures.js";

const EXPECTED_RISKY_TRANSITIONS = Object.freeze([
  "ownership-transfer",
  "ownership-recovery",
  "suspension",
  "carry-forward-claim",
  "end-amendment",
  "end-cancellation",
  "abandonment",
] as const);

interface CheckpointServiceLike {
  record(transaction: unknown, command: unknown): {
    readonly append: {
      readonly events: readonly Readonly<Record<string, unknown>>[];
      readonly publicResponse: Readonly<Record<string, unknown>>;
    };
    readonly afterAppend: (committed: unknown, transaction: unknown) => void;
  };
  prepareFinalPhase(transaction: unknown, input: unknown): {
    readonly action: InternalWorkflowPhaseCommand["action"];
    readonly effect: ReturnType<CheckpointServiceLike["record"]>;
  };
  recordPreparedFinal(
    transaction: unknown,
    prepared: unknown,
  ): ReturnType<CheckpointServiceLike["record"]>;
  prepareRootSuspension(transaction: unknown, input: unknown): {
    readonly checkpoint: Readonly<Record<string, unknown>>;
    readonly checkpointFingerprint: string;
    readonly event: Readonly<Record<string, unknown>>;
  };
}

type CheckpointServiceModule = Readonly<Record<string, unknown>> & {
  readonly CheckpointService?: new (options: unknown) => CheckpointServiceLike;
  readonly checkpointAgeDiagnosticV1?: (input: unknown) => Readonly<Record<string, unknown>>;
  readonly requireRiskyTransitionCheckpointV1?: (input: unknown) => unknown;
  readonly decodeCheckpointRecordedResult?: (input: unknown) => Readonly<Record<string, unknown>>;
};

async function optionalCheckpointServiceModule(): Promise<CheckpointServiceModule> {
  const moduleSpecifier = "../src/orchestrator/lifecycle/checkpoint.service.js";
  try {
    return await import(moduleSpecifier) as CheckpointServiceModule;
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { readonly code?: unknown }).code === "ERR_MODULE_NOT_FOUND"
    ) {
      class MissingCheckpointService implements CheckpointServiceLike {
        record(): ReturnType<CheckpointServiceLike["record"]> {
          return {
            append: { events: Object.freeze([]), publicResponse: Object.freeze({}) },
            afterAppend: () => undefined,
          };
        }
        prepareFinalPhase(): ReturnType<CheckpointServiceLike["prepareFinalPhase"]> {
          throw new Error("MISSING_CHECKPOINT_SERVICE");
        }
        recordPreparedFinal(): ReturnType<CheckpointServiceLike["record"]> {
          throw new Error("MISSING_CHECKPOINT_SERVICE");
        }
        prepareRootSuspension(): ReturnType<CheckpointServiceLike["prepareRootSuspension"]> {
          throw new Error("MISSING_CHECKPOINT_SERVICE");
        }
      }
      return Object.freeze({ CheckpointService: MissingCheckpointService });
    }
    throw error;
  }
}

function childSessionId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORKSPACE_ID = "a".repeat(64);
const ROOT_ID = "33333333-3333-4333-8333-333333333333";
const CHILD_ID = "44444444-4444-4444-8444-444444444444";
const COMMAND_ID = "55555555-5555-4555-8555-555555555555";
const IDEMPOTENCY_KEY = "checkpoint-test/v1";
const CHECKPOINT_ID = "66666666-6666-4666-8666-666666666666";
const WORKFLOW_ID = "77777777-7777-4777-8777-777777777777";
const CLAIM_OWNER_ID = "88888888-8888-4888-8888-888888888888";
const CREATED_AT = "2026-07-18T01:02:03.004Z";

function draft(): Readonly<Record<string, unknown>> {
  const fixture = checkpointFixture();
  const {
    checkpointId: _checkpointId,
    sessionId: _sessionId,
    parentSessionId: _parentSessionId,
    baseEventPosition: _baseEventPosition,
    checkpointEventPosition: _checkpointEventPosition,
    createdAt: _createdAt,
    creatorAgentId: _creatorAgentId,
    creatorClientInstanceId: _creatorClientInstanceId,
    sourceState: _sourceState,
    childSummaries: _childSummaries,
    evidenceCoverage: _evidenceCoverage,
    ...content
  } = fixture;
  return content;
}

function qualifiedDraft(): Readonly<Record<string, unknown>> {
  const fixture = qualifiedCheckpointFixture();
  const {
    checkpointId: _checkpointId,
    sessionId: _sessionId,
    parentSessionId: _parentSessionId,
    baseEventPosition: _baseEventPosition,
    checkpointEventPosition: _checkpointEventPosition,
    createdAt: _createdAt,
    creatorAgentId: _creatorAgentId,
    creatorClientInstanceId: _creatorClientInstanceId,
    sourceState: _sourceState,
    childSummaries: _childSummaries,
    evidenceCoverage: _evidenceCoverage,
    ...content
  } = fixture;
  return content;
}

function checkpointCommand(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    commandType: "record-checkpoint",
    commandId: COMMAND_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    agentId: "agent-checkpoint",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: "refs/heads/current",
    sessionId: ROOT_ID,
    expectedStreamVersion: "3",
    expectedBaseEventPosition: "50",
    draft: draft(),
    ...overrides,
  });
}

function childCheckpointCommand(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return checkpointCommand({
    commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    idempotencyKey: "checkpoint-test/child",
    sessionId: CHILD_ID,
    expectedStreamVersion: "2",
    ...overrides,
  });
}

function internalFinalCheckpointPlan(
  checkpointVersion: 1 | 2,
): InternalWorkflowPhasePlan {
  const commandId = checkpointVersion === 1
    ? "99999999-9999-4999-8999-999999999999"
    : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const idempotencyKey = `checkpoint-test/internal-final/v${checkpointVersion}`;
  const workflowId = WORKFLOW_ID as InternalWorkflowPhasePlan["workflowId"];
  const plannedWorkId = internalPhasePlannedWorkId({
    workflowId,
    workflowGeneration: 1n,
    sourcePhase: "children-resolved",
    action: "prepare-final-checkpoint-and-queue-ending",
    commandId,
    idempotencyKey,
  });
  const plannedAction: InternalWorkflowPhasePlan["plannedAction"] = checkpointVersion === 1
    ? Object.freeze({
        action: "prepare-final-checkpoint-and-queue-ending" as const,
        finalCheckpointDraft: decodeCheckpointDraftV1(draft()),
        materializationTarget: "memory/final.md",
      })
    : Object.freeze({
        action: "prepare-final-checkpoint-and-queue-ending" as const,
        finalCheckpointDraft: decodeCheckpointDraftV2(qualifiedDraft()),
        materializationTarget: "memory/final.md",
      });
  return Object.freeze({
    commandType: "internal-workflow-phase",
    commandId,
    idempotencyKey,
    agentId: "agent-checkpoint",
    expectedProjectId: PROJECT_ID as InternalWorkflowPhasePlan["expectedProjectId"],
    expectedVaultId: VAULT_ID as InternalWorkflowPhasePlan["expectedVaultId"],
    expectedWorkspaceId: WORKSPACE_ID as InternalWorkflowPhasePlan["expectedWorkspaceId"],
    expectedBranchRef: "refs/heads/current",
    workflowId,
    workflowGeneration: 1,
    sourcePhase: "children-resolved",
    plannedWorkId,
    claim: Object.freeze({
      workflowId,
      workflowGeneration: 1,
      claimOwnerId: CLAIM_OWNER_ID,
      claimToken: "1",
      claimExpiresAt: "2026-07-18T01:12:03.004Z",
    }),
    plannedAction,
  });
}

function internalPlanAuthorization(
  plan: InternalWorkflowPhasePlan,
): Extract<PersistedLifecycleAuthorizationRecord, { readonly kind: "internal-workflow" }> {
  const principal = Object.freeze({
    actorRole: "primary" as const,
    clientInstanceId: "primary-client",
  });
  return {
    kind: "internal-workflow",
    workflowId: plan.workflowId,
    workflowGeneration: BigInt(plan.workflowGeneration),
    plannedWorkId: plan.plannedWorkId,
    claimOwnerId: plan.claim.claimOwnerId,
    claimToken: BigInt(plan.claim.claimToken),
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    presenting: principal,
    target: principal,
  };
}

function internalPlanEnvelope(
  context: ProjectContext,
  plan: InternalWorkflowPhasePlan,
): LifecycleCommandEnvelope {
  const authorization = internalPlanAuthorization(plan);
  const replayExpectation = {
    kind: "internal-workflow" as const,
    workflowId: plan.workflowId,
    workflowGeneration: BigInt(plan.workflowGeneration),
    plannedWorkId: plan.plannedWorkId,
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    presenting: authorization.presenting,
    target: authorization.target,
  };
  const executionPlan: InternalWorkflowExecutionPlan = plan;
  const witness = buildLifecycleIntentWitness(executionPlan, internalPlanAssertions(plan));
  return {
    context,
    commandId: plan.commandId,
    idempotencyKey: plan.idempotencyKey,
    commandType: plan.commandType,
    candidateIntentHash: witness.intentHash,
    authoritativeIntentHash: witness.intentHash,
    semanticCommand: plan,
    capabilityKind: null,
    capabilityGeneration: null,
    replayExpectation,
  };
}

function internalPlanAssertions(
  plan: InternalWorkflowPhasePlan,
): TrustedLifecycleIntentAssertionsV1 {
  return {
    authorizationKind: "internal-workflow",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: null,
    capabilityGeneration: null,
    presentingActorRole: "primary",
    presentingClientInstanceId: "primary-client",
    targetActorRole: "primary",
    targetClientInstanceId: "primary-client",
    internalWorkflowId: plan.workflowId,
    internalWorkflowGeneration: plan.workflowGeneration,
    internalPlannedWorkId: plan.plannedWorkId,
  };
}

function contextAndScope(projectRoot: string): {
  readonly context: ProjectContext;
  readonly scope: Readonly<Record<string, unknown>>;
} {
  const vaultRoot = join(projectRoot, "memory");
  const descriptorPath = join(vaultRoot, ".project", "descriptor.json");
  const storeRoot = join(projectRoot, ".store", "v2");
  const privateStateRoot = join(projectRoot, ".private");
  mkdirSync(join(vaultRoot, ".project"), { recursive: true });
  mkdirSync(storeRoot, { recursive: true });
  mkdirSync(privateStateRoot, { recursive: true });
  const workspace = {
    kind: "git" as const,
    worktreeRoot: projectRoot,
    gitDir: join(projectRoot, ".git"),
    gitCommonDir: join(projectRoot, ".git"),
    headCommit: "1".repeat(40),
    branchRef: "refs/heads/current",
    detached: false,
    workspaceId: WORKSPACE_ID as ProjectContext["workspace"]["workspaceId"],
  };
  const context: ProjectContext = {
    binding: {
      projectBindingId: "checkpoint-binding",
      generation: 1,
      contextFingerprint: "c".repeat(64),
      source: "explicit-cli",
      projectId: PROJECT_ID as ProjectContext["binding"]["projectId"],
      vaultId: VAULT_ID as ProjectContext["binding"]["vaultId"],
      storeId: STORE_ID as ProjectContext["binding"]["storeId"],
      workspaceId: WORKSPACE_ID as ProjectContext["binding"]["workspaceId"],
      clientNamespace: "tests",
      clientInstanceId: "primary-client",
      actorRole: "primary",
      projectRoot,
      vaultRoot,
      descriptorPath,
      storeRoute: {
        kind: "git-common",
        storeRoot,
        eventsPath: join(storeRoot, "events.sqlite"),
        storeManifestPath: join(storeRoot, "store-manifest.json"),
        projectionManifestPath: join(storeRoot, "projection-manifest.json"),
      },
      workspace,
      establishedAt: CREATED_AT,
    },
    workspace,
    checkedAt: CREATED_AT,
  };
  return {
    context,
    scope: Object.freeze({
      scopeVersion: 1,
      descriptorPath,
      storeRoot,
      privateStateRoot,
      exactMaterializationTargets: Object.freeze([]),
      exactCommittedTempPaths: Object.freeze([]),
    }),
  };
}

interface AuthorityHarness {
  readonly transaction: Readonly<Record<string, unknown>>;
  readonly root: Readonly<Record<string, unknown>>;
  readonly rootAggregate: Readonly<Record<string, unknown>>;
  readonly calls: {
    checkpointUpdates: unknown[];
    clears: unknown[];
    sourceCaptures: unknown[];
    latestCheckpointReads: unknown[];
    version1Eligibility: unknown[];
    version2Snapshots: unknown[];
    identities: unknown[];
    clocks: unknown[];
    foldReads: unknown[];
    childLists: unknown[];
  };
}

function authorityHarness(options: {
  readonly basePosition?: bigint;
  readonly markerPosition?: bigint | null;
  readonly faultPoint?: string;
  readonly corruptLatestCheckpointFingerprint?: boolean;
  readonly corruptChildLatestCheckpointFingerprint?: boolean;
  readonly eligibilityError?: Error;
  readonly snapshotError?: Error;
  readonly snapshot?: Readonly<Record<string, unknown>>;
  readonly target?: "root" | "child";
} = {}): AuthorityHarness {
  const calls = {
    checkpointUpdates: [] as unknown[],
    clears: [] as unknown[],
    sourceCaptures: [] as unknown[],
    latestCheckpointReads: [] as unknown[],
    version1Eligibility: [] as unknown[],
    version2Snapshots: [] as unknown[],
    identities: [] as unknown[],
    clocks: [] as unknown[],
    foldReads: [] as unknown[],
    childLists: [] as unknown[],
  };
  const priorCheckpointId = options.corruptLatestCheckpointFingerprint === true
    ? "77777777-7777-4777-8777-777777777777"
    : null;
  const childCheckpointId = options.corruptChildLatestCheckpointFingerprint === true
    ? "88888888-8888-4888-8888-888888888888"
    : null;
  const root = Object.freeze({
    projectId: PROJECT_ID,
    sessionId: ROOT_ID,
    streamId: `session/${ROOT_ID}`,
    sessionKind: "root",
    parentSessionId: null,
    workspaceId: WORKSPACE_ID,
    semanticState: "active",
    latestCheckpointId: priorCheckpointId,
    latestCheckpointEventPosition: priorCheckpointId === null ? null : 49n,
    latestCheckpointFingerprint: priorCheckpointId === null ? null : "f".repeat(64),
    checkpointRequiredReason: options.markerPosition == null ? null : "accepted-child-report",
    checkpointRequiredEventPosition: options.markerPosition ?? null,
  });
  const child = Object.freeze({
    projectId: PROJECT_ID,
    sessionId: CHILD_ID,
    streamId: `session/${CHILD_ID}`,
    sessionKind: "child",
    parentSessionId: ROOT_ID,
    workspaceId: WORKSPACE_ID,
    semanticState: "active",
    latestCheckpointId: childCheckpointId,
    latestCheckpointEventPosition: childCheckpointId === null ? null : 39n,
    latestCheckpointFingerprint: childCheckpointId === null ? null : "e".repeat(64),
    checkpointRequiredReason: options.target === "child" && options.markerPosition != null
      ? "child-checkpoint-required"
      : null,
    checkpointRequiredEventPosition: options.target === "child"
      ? options.markerPosition ?? null
      : null,
  });
  const rootAggregate = Object.freeze({
    kind: "root",
    state: "active",
    projectId: PROJECT_ID,
    sessionId: ROOT_ID,
    parentSessionId: null,
    streamId: `session/${ROOT_ID}`,
    workspaceId: WORKSPACE_ID,
    streamVersion: 3n,
    eventPosition: 30n,
    terminalEventPosition: null,
    correlationId: "77777777-7777-4777-8777-777777777777",
    latestCheckpointId: priorCheckpointId,
    latestCheckpointEventPosition: priorCheckpointId === null ? null : 49n,
    latestCheckpointBaseEventPosition: priorCheckpointId === null ? null : 48n,
  });
  const childAggregate = Object.freeze({
    kind: "child",
    state: "active",
    projectId: PROJECT_ID,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    streamId: `session/${CHILD_ID}`,
    workspaceId: WORKSPACE_ID,
    streamVersion: 2n,
    eventPosition: 40n,
    terminalEventPosition: null,
    correlationId: "77777777-7777-4777-8777-777777777777",
    latestCheckpointId: childCheckpointId,
    latestCheckpointEventPosition: childCheckpointId === null ? null : 39n,
    latestCheckpointBaseEventPosition: childCheckpointId === null ? null : 38n,
  });
  const authority = Object.freeze({
    get: (projectId: string, sessionId: string) => projectId !== PROJECT_ID
      ? null
      : sessionId === ROOT_ID
        ? root
        : sessionId === CHILD_ID
          ? child
          : null,
    requireFoldMatch: (record: { readonly sessionId: string }) => {
      calls.foldReads.push(record.sessionId);
      return record.sessionId === ROOT_ID ? rootAggregate : childAggregate;
    },
    latestCheckpoint: (record: { readonly sessionId: string }) => {
      calls.latestCheckpointReads.push(record);
      if (options.corruptLatestCheckpointFingerprint === true && record.sessionId === ROOT_ID) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      if (options.corruptChildLatestCheckpointFingerprint === true && record.sessionId === CHILD_ID) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      return null;
    },
    listNonterminalChildren: (projectId: string, rootSessionId: string) => {
      calls.childLists.push({ projectId, rootSessionId });
      return projectId === PROJECT_ID && rootSessionId === ROOT_ID
        ? Object.freeze([child])
        : Object.freeze([]);
    },
    nextGlobalPosition: () => (options.basePosition ?? 50n) + 1n,
    updateCheckpointIndex: (input: unknown) => {
      if (options.faultPoint === "before-checkpoint-index-cas") throw new Error("INJECTED_CHECKPOINT_CRASH");
      calls.checkpointUpdates.push(input);
      return true;
    },
    clearCheckpointRequired: (input: unknown) => {
      calls.clears.push(input);
      return options.markerPosition !== null && options.markerPosition !== undefined;
    },
  });
  return {
    calls,
    root,
    rootAggregate,
    transaction: Object.freeze({
      authority,
      transfers: Object.freeze({
        listUnclaimedEndingScopeProjectionsBySourceRoot: () => Object.freeze([{
          projectId: PROJECT_ID,
          rootSessionId: ROOT_ID,
          childSessionId: "99999999-9999-4999-8999-999999999999",
        }]),
      }),
      coverage: Object.freeze({
        assertVersion1Eligible: (sessionIds: readonly string[]) => {
          calls.version1Eligibility.push([...sessionIds]);
          if (options.eligibilityError !== undefined) throw options.eligibilityError;
        },
        snapshotV2: (sessionId: string, baseEventPosition: bigint) => {
          calls.version2Snapshots.push({ sessionId, baseEventPosition });
          if (options.snapshotError !== undefined) throw options.snapshotError;
          return options.snapshot ?? Object.freeze({
            coverageVersion: 2,
            captureMode: "coverage-only",
            contentRetained: false,
            adapterSessions: Object.freeze([]),
          });
        },
      }),
    }),
  };
}

async function checkpointServiceFixture(options: {
  readonly authorizationRecord?: PersistedLifecycleAuthorizationRecord;
  readonly basePosition?: bigint;
  readonly markerPosition?: bigint | null;
  readonly faultPoint?: string;
  readonly freshCapabilityGeneration?: string | null;
  readonly corruptLatestCheckpointFingerprint?: boolean;
  readonly corruptChildLatestCheckpointFingerprint?: boolean;
  readonly eligibilityError?: Error;
  readonly snapshotError?: Error;
  readonly snapshot?: Readonly<Record<string, unknown>>;
  readonly target?: "root" | "child";
} = {}): Promise<{
  readonly service: CheckpointServiceLike;
  readonly harness: AuthorityHarness;
  readonly context: ProjectContext;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly cleanup: () => void;
}> {
  const module = await optionalCheckpointServiceModule();
  assert.equal(typeof module.CheckpointService, "function");
  const projectRoot = mkdtempSync(join(tmpdir(), "checkpoint-v1-"));
  const { context, scope } = contextAndScope(projectRoot);
  const harness = authorityHarness(options);
  const invocation = Object.freeze({
    context,
    sourceStateScope: scope,
    authorizationRecord: options.authorizationRecord
      ?? Object.freeze({ kind: "protected" }),
    ...(options.freshCapabilityGeneration === null
      ? {}
      : { freshCapabilityGeneration: options.freshCapabilityGeneration ?? "1" }),
  });
  const sourceStateProvider = Object.freeze({
    captureForCheckpoint: (observedContext: ProjectContext, observedScope: unknown) => {
      harness.calls.sourceCaptures.push({ observedContext, observedScope });
      return Object.freeze({
        sourceStateScopeVersion: 1,
        workspaceId: WORKSPACE_ID,
        branchRef: "refs/heads/current",
        headCommit: "2".repeat(40),
        dirtyWorktreeFingerprint: "d".repeat(64),
      });
    },
    captureForFinalization: (observedContext: ProjectContext, observedScope: unknown) => {
      harness.calls.sourceCaptures.push({ observedContext, observedScope, final: true });
      return Object.freeze({
        sourceStateScopeVersion: 1,
        workspaceId: WORKSPACE_ID,
        branchRef: "refs/heads/current",
        headCommit: "2".repeat(40),
        dirtyWorktreeFingerprint: "d".repeat(64),
      });
    },
  });
  const Service = module.CheckpointService!;
  return {
    service: new Service({
      invocationScope: { current: () => invocation },
      sourceStateProvider,
      identitySource: {
        uuid: () => {
          harness.calls.identities.push(true);
          return CHECKPOINT_ID;
        },
      },
      clock: {
        now: () => {
          harness.calls.clocks.push(true);
          return CREATED_AT;
        },
      },
      coverageSnapshot: {
        capture: () => Object.freeze({
          captureMode: "coverage-only",
          contentRetained: false,
          highestContiguousOrdinal: "4",
          missingIntervals: Object.freeze([{ firstOrdinal: "5", lastOrdinal: "6" }]),
        }),
      },
      faultInjector: options.faultPoint === undefined ? undefined : (point: string) => {
        if (point === options.faultPoint) throw new Error("INJECTED_CHECKPOINT_CRASH");
      },
    }),
    harness,
    context,
    scope,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function committedCheckpointBatch(
  position = 51n,
  streamVersion = 4n,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    events: Object.freeze([Object.freeze({
      globalPosition: position,
      streamVersion,
      eventType: "SessionCheckpointRecorded",
    })]),
    storedResponse: Object.freeze({}) as JsonValue,
    responseHash: "e".repeat(64),
  });
}

class InternalPlanStoreConnection implements SqliteConnection {
  readonly statements: string[] = [];

  exec(sql: string): void {
    this.statements.push(sql.trim().replace(/\s+/gu, " ").toUpperCase());
  }

  prepare(_sql: string): SqliteStatement {
    throw new Error("internal plan harness does not issue raw SQL");
  }

  close(): void {}
}

class InternalPlanEvents implements LifecycleEventAppendPort {
  readonly calls: string[] = [];
  readonly insertedAuthorizations: PersistedLifecycleAuthorizationRecord[] = [];

  constructor(readonly replay: EventAppendReplay<JsonValue> | null) {}

  findLifecycleReplay<T extends JsonValue>(
    _command: LifecycleCommandEnvelope,
  ): EventAppendReplay<T> | null {
    this.calls.push("find-replay");
    return this.replay as EventAppendReplay<T> | null;
  }

  assertCommandIdentityAvailable(_command: LifecycleCommandEnvelope): void {
    this.calls.push("assert-command-id");
  }

  assertAppendAllowed(): void {
    this.calls.push("assert-append");
  }

  prepare<T extends JsonValue>(
    command: AppendCommand<T>,
    recordedAt: string,
    commandHashOverride: string,
  ): PreparedEventAppend<T> {
    this.calls.push("prepare");
    return {
      command,
      recordedAt,
      commandHash: commandHashOverride,
      storedEventIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    };
  }

  planPrepared<T extends JsonValue>(
    prepared: PreparedEventAppend<T>,
  ): PlannedEventAppend<T> {
    this.calls.push("plan");
    const events = prepared.command.events.map((pending, index) => ({
      globalPosition: 51n + BigInt(index),
      streamVersion: prepared.command.expectedStreamVersion + BigInt(index) + 1n,
      eventType: pending.eventType,
      payload: pending.payload,
    })) as unknown as EventAppendBatch<T>["events"];
    return {
      plannedOnly: true,
      events,
      storedResponse: {
        eventIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
        firstGlobalPosition: "51",
        lastGlobalPosition: "51",
        finalStreamVersion: (
          prepared.command.expectedStreamVersion + BigInt(events.length)
        ).toString(),
        response: prepared.command.publicResponse as PlannedEventAppend<T>[
          "storedResponse"
        ]["response"],
      },
      responseHash: "c".repeat(64),
    };
  }

  appendPlanned<T extends JsonValue>(
    planned: PlannedEventAppend<T>,
  ): EventAppendBatch<T> {
    this.calls.push("append");
    return planned;
  }

  insertDedup<T extends JsonValue>(
    _prepared: PreparedEventAppend<T>,
    _batch: EventAppendBatch<T>,
    authorization: PersistedLifecycleAuthorizationRecord,
  ): void {
    this.calls.push("dedup");
    this.insertedAuthorizations.push(authorization);
  }

  result<T extends JsonValue>(batch: EventAppendBatch<T>) {
    this.calls.push("result");
    return {
      deduplicated: false,
      firstGlobalPosition: BigInt(batch.storedResponse.firstGlobalPosition),
      lastGlobalPosition: BigInt(batch.storedResponse.lastGlobalPosition),
      finalStreamVersion: BigInt(batch.storedResponse.finalStreamVersion),
      eventIds: [...batch.storedResponse.eventIds],
      response: batch.storedResponse.response as T,
      responseHash: batch.responseHash,
    };
  }
}

function completeCheckpointTransaction(
  harness: AuthorityHarness,
): LifecycleCommandTransaction {
  const partial = harness.transaction as {
    readonly authority: LifecycleCommandTransaction["authority"];
    readonly coverage: {
      assertVersion1Eligible(
        sessionIds: readonly string[],
      ): void;
      snapshotV2(
        sessionId: string,
        baseEventPosition: bigint,
      ): ReturnType<LifecycleCommandTransaction["coverage"]["snapshotV2"]>;
    };
  };
  return Object.freeze({
    authority: partial.authority,
    leases: Object.freeze({}),
    approvals: Object.freeze({}),
    transfers: Object.freeze({}),
    coverage: Object.freeze({
      assertEvidenceWindowWritable: () => undefined,
      assertQuickHealthy: () => undefined,
      registerAffectedExistingSessions: () => undefined,
      assertVersion1Eligible: (sessionIds: readonly string[]) =>
        partial.coverage.assertVersion1Eligible(sessionIds),
      prepareBatch: () => {
        throw new Error("unused evidence coverage preparation");
      },
      persistPrepared: () => {
        throw new Error("unused evidence coverage persistence");
      },
      snapshotV2: (sessionId: string, baseEventPosition: bigint) =>
        partial.coverage.snapshotV2(sessionId, baseEventPosition),
      minimumCheckpointUpperBound: () => 0,
      minimumFinalEndingScopeBindingsUpperBound: () => 0,
    }),
    workflows: Object.freeze({}),
    validation: Object.freeze({}),
    outbox: Object.freeze({}),
  });
}

function checkpointCommandFromPlan(
  plan: InternalWorkflowPhasePlan,
): RecordCheckpointCommandV2 | RecordCheckpointCommandV3 {
  if (plan.plannedAction.action !== "prepare-final-checkpoint-and-queue-ending") {
    throw new Error("expected final checkpoint phase plan");
  }
  const command = {
    commandType: "record-checkpoint" as const,
    commandId: plan.commandId,
    idempotencyKey: plan.idempotencyKey,
    agentId: plan.agentId,
    expectedProjectId: plan.expectedProjectId,
    expectedVaultId: plan.expectedVaultId,
    expectedWorkspaceId: plan.expectedWorkspaceId,
    expectedBranchRef: plan.expectedBranchRef,
    sessionId: ROOT_ID as RecordCheckpointCommandV2["sessionId"],
    expectedStreamVersion: "3",
    expectedBaseEventPosition: "50",
  };
  return plan.plannedAction.finalCheckpointDraft.checkpointVersion === 1
    ? { ...command, draft: plan.plannedAction.finalCheckpointDraft }
    : { ...command, draft: plan.plannedAction.finalCheckpointDraft };
}

function internalPlanReplay(
  plan: InternalWorkflowPhasePlan,
): EventAppendReplay<JsonValue> {
  const checkpointVersion = plan.plannedAction.action
      === "prepare-final-checkpoint-and-queue-ending"
    ? plan.plannedAction.finalCheckpointDraft.checkpointVersion
    : 1;
  return {
    deduplicated: true,
    firstGlobalPosition: 51n,
    lastGlobalPosition: 51n,
    finalStreamVersion: 4n,
    eventIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    response: {
      checkpointVersion,
      checkpointId: CHECKPOINT_ID,
      sessionId: ROOT_ID,
      baseEventPosition: "50",
      checkpointEventPosition: "51",
      finalStreamVersion: "4",
      checkpointRequiredCleared: false,
    },
    responseHash: "c".repeat(64),
    authorizationRecord: internalPlanAuthorization(plan),
  };
}

function adaptPreparedInternalCommit(
  effect: ReturnType<CheckpointServiceLike["record"]>,
): PreparedLifecycleCommit<JsonValue> {
  const commit = effect as unknown as PreparedLifecycleCommit<JsonValue>;
  return {
    ...commit,
    append: {
      ...commit.append,
      commandType: "internal-workflow-phase",
    },
  };
}

describe("Checkpoint Version 1 contract corrections", () => {
  it("strictly decodes versioned checkpoint results without mixed fields", async () => {
    const module = await optionalCheckpointServiceModule();
    assert.equal(typeof module.decodeCheckpointRecordedResult, "function");
    for (const checkpointVersion of [1, 2] as const) {
      const result = {
        checkpointVersion,
        checkpointId: CHECKPOINT_ID,
        sessionId: ROOT_ID,
        baseEventPosition: "50",
        checkpointEventPosition: "51",
        finalStreamVersion: "4",
        checkpointRequiredCleared: false,
      };
      assert.deepEqual(module.decodeCheckpointRecordedResult!(result), result);
      assert.throws(
        () => module.decodeCheckpointRecordedResult!({ ...result, checkpointBody: {} }),
        /LIFECYCLE_INPUT_INVALID/u,
      );
    }
    assert.throws(() => module.decodeCheckpointRecordedResult!({
      checkpointVersion: 2,
      checkpointId: CHECKPOINT_ID,
      sessionId: ROOT_ID,
      baseEventPosition: "51",
      checkpointEventPosition: "51",
      finalStreamVersion: "4",
      checkpointRequiredCleared: false,
    }), /LIFECYCLE_INPUT_INVALID/u);
  });

  it("records explicit non-retention in coverage-only checkpoint evidence", () => {
    const checkpoint = decodeCheckpointV1(checkpointFixture());
    assert.equal(
      (checkpoint.evidenceCoverage as unknown as { readonly contentRetained?: unknown }).contentRetained,
      false,
    );
  });

  it("does not apply the unrelated 200 material-entry cap to child summaries", () => {
    const checkpoint = checkpointFixture();
    const childSummaries = Array.from({ length: 201 }, (_, index) => ({
      childSessionId: childSessionId(index + 1),
      state: "active",
      lastEventPosition: (index + 1).toString(),
      streamVersion: "1",
      latestCheckpointId: null,
    }));

    const decoded = decodeCheckpointV1({ ...checkpoint, childSummaries });
    assert.equal(decoded.childSummaries.length, 201);
  });

  it("requires allowlisted confidence and rejects secret-bearing execution fields", () => {
    assert.throws(() => decodeCheckpointDraftV1({
      ...draft(),
      materialClaims: [{
        claimId: CHILD_ID,
        summary: "A material claim",
        evidenceReferences: ["coverage:1"],
        confidence: "certain",
      }],
    }), /LIFECYCLE_INPUT_INVALID/u);

    const execution = {
      label: "focused test",
      result: "passed",
      exitClassification: "passed",
      outputFingerprint: null,
      artifactReference: null,
      confidence: "high",
    };
    assert.equal(decodeCheckpointDraftV1({
      ...draft(),
      commandResults: [execution],
    }).commandResults.length, 1);
    for (const forbidden of ["rawOutput", "rawCommand", "environment", "secret"] as const) {
      assert.throws(() => decodeCheckpointDraftV1({
        ...draft(),
        commandResults: [{ ...execution, [forbidden]: "private" }],
      }), /LIFECYCLE_INPUT_INVALID/u, forbidden);
    }
  });
});

describe("Checkpoint age diagnostics", () => {
  it("reports the fixed time trigger and never fabricates a lifecycle event", async () => {
    const module = await optionalCheckpointServiceModule();
    assert.equal(typeof module.checkpointAgeDiagnosticV1, "function");
    const checkpoint = decodeCheckpointV1({
      ...checkpointFixture(),
      createdAt: "2026-07-18T01:00:00.000Z",
    });
    const authority = {
      projectId: PROJECT_ID,
      sessionId: checkpoint.sessionId,
      createdAt: "2026-07-18T00:00:00.000Z",
      latestCheckpointId: checkpoint.checkpointId,
      latestCheckpointEventPosition: BigInt(checkpoint.checkpointEventPosition),
      latestCheckpointFingerprint: createHash("sha256")
        .update("project-memory/checkpoint/v1\n", "utf8")
        .update(canonicalJson(checkpoint), "utf8")
        .digest("hex"),
      checkpointRequiredReason: null,
      checkpointRequiredEventPosition: null,
    };

    const fresh = module.checkpointAgeDiagnosticV1!({
      authority,
      checkpoint,
      observedAt: "2026-07-18T01:14:59.999Z",
    });
    const due = module.checkpointAgeDiagnosticV1!({
      authority,
      checkpoint,
      observedAt: "2026-07-18T01:15:00.000Z",
    });

    assert.equal(fresh.ageMilliseconds, "899999");
    assert.equal(fresh.checkpointDue, false);
    assert.equal(due.ageMilliseconds, "900000");
    assert.equal(due.checkpointDue, true);
    assert.equal(due.ageLimitMilliseconds, "900000");
    assert.equal(Object.hasOwn(due, "eventType"), false);
    assert.equal(Object.hasOwn(due, "events"), false);
    assert.equal(Object.hasOwn(due, "payload"), false);
  });
});

describe("RiskyTransitionPolicy Version 1", () => {
  it("exposes the complete fixed server transition enumeration", async () => {
    const checkpointService = await optionalCheckpointServiceModule();
    assert.deepEqual(checkpointService.RISKY_TRANSITIONS_V1, EXPECTED_RISKY_TRANSITIONS);
  });

  it("requires an unmarked latest checkpoint at the target stream tip", async () => {
    const module = await optionalCheckpointServiceModule();
    assert.equal(typeof module.requireRiskyTransitionCheckpointV1, "function");
    const checkpoint = decodeCheckpointV1(checkpointFixture());
    const authority = Object.freeze({
      projectId: checkpointFixture().sourceState.workspaceId,
      sessionId: checkpoint.sessionId,
      streamId: `session/${checkpoint.sessionId}`,
      sessionKind: "root",
      parentSessionId: null,
      workspaceId: checkpoint.sourceState.workspaceId,
      latestCheckpointId: checkpoint.checkpointId,
      latestCheckpointEventPosition: BigInt(checkpoint.checkpointEventPosition),
      latestCheckpointFingerprint: createHash("sha256")
        .update("project-memory/checkpoint/v1\n", "utf8")
        .update(canonicalJson(checkpoint), "utf8")
        .digest("hex"),
      checkpointRequiredReason: null,
      checkpointRequiredEventPosition: null,
    });
    const aggregate = Object.freeze({
      kind: "root",
      state: "active",
      projectId: authority.projectId,
      sessionId: authority.sessionId,
      streamId: authority.streamId,
      parentSessionId: null,
      workspaceId: authority.workspaceId,
      streamVersion: 2n,
      eventPosition: BigInt(checkpoint.checkpointEventPosition),
      latestCheckpointId: checkpoint.checkpointId,
      latestCheckpointBaseEventPosition: BigInt(checkpoint.baseEventPosition),
      latestCheckpointEventPosition: BigInt(checkpoint.checkpointEventPosition),
      terminalEventPosition: null,
    });

    assert.doesNotThrow(() => module.requireRiskyTransitionCheckpointV1!({
      authority,
      aggregate,
      checkpoint,
      relevantChildren: [],
    }));
    assert.throws(() => module.requireRiskyTransitionCheckpointV1!({
      authority,
      aggregate: { ...aggregate, eventPosition: aggregate.eventPosition + 1n },
      checkpoint,
      relevantChildren: [],
    }), /CHECKPOINT_BASE_INVALID/u);
    assert.throws(() => module.requireRiskyTransitionCheckpointV1!({
      authority: {
        ...authority,
        checkpointRequiredReason: "ownership-transfer",
        checkpointRequiredEventPosition: aggregate.eventPosition,
      },
      aggregate,
      checkpoint,
      relevantChildren: [],
    }), /CHECKPOINT_BASE_INVALID/u);
  });

  it("rejects a root checkpoint whose relevant child summary is stale", async () => {
    const module = await optionalCheckpointServiceModule();
    const childSession = childSessionId(900);
    const checkpoint = decodeCheckpointV1({
      ...checkpointFixture({ baseEventPosition: 10, checkpointEventPosition: 11 }),
      childSummaries: [{
        childSessionId: childSession,
        state: "active",
        lastEventPosition: "9",
        streamVersion: "3",
        latestCheckpointId: null,
      }],
    });
    const authority = {
      projectId: PROJECT_ID,
      sessionId: checkpoint.sessionId,
      streamId: `session/${checkpoint.sessionId}`,
      sessionKind: "root",
      parentSessionId: null,
      workspaceId: checkpoint.sourceState.workspaceId,
      latestCheckpointId: checkpoint.checkpointId,
      latestCheckpointEventPosition: 11n,
      latestCheckpointFingerprint: createHash("sha256")
        .update("project-memory/checkpoint/v1\n", "utf8")
        .update(canonicalJson(checkpoint), "utf8")
        .digest("hex"),
      checkpointRequiredReason: null,
      checkpointRequiredEventPosition: null,
    };
    const aggregate = {
      kind: "root",
      state: "active",
      projectId: PROJECT_ID,
      sessionId: checkpoint.sessionId,
      streamId: authority.streamId,
      parentSessionId: null,
      workspaceId: authority.workspaceId,
      streamVersion: 4n,
      eventPosition: 11n,
      latestCheckpointId: checkpoint.checkpointId,
      latestCheckpointBaseEventPosition: 10n,
      latestCheckpointEventPosition: 11n,
      terminalEventPosition: null,
    };
    const childAuthority = {
      projectId: PROJECT_ID,
      sessionId: childSession,
      streamId: `session/${childSession}`,
      sessionKind: "child",
      parentSessionId: checkpoint.sessionId,
      workspaceId: authority.workspaceId,
      terminalEventPosition: null,
    };
    const childAggregate = {
      kind: "child",
      state: "active",
      projectId: PROJECT_ID,
      sessionId: childSession,
      streamId: childAuthority.streamId,
      parentSessionId: checkpoint.sessionId,
      workspaceId: authority.workspaceId,
      streamVersion: 3n,
      eventPosition: 9n,
      latestCheckpointId: null,
      terminalEventPosition: null,
    };

    assert.doesNotThrow(() => module.requireRiskyTransitionCheckpointV1!({
      authority,
      aggregate,
      checkpoint,
      relevantChildren: [{ authority: childAuthority, aggregate: childAggregate }],
    }));
    assert.throws(() => module.requireRiskyTransitionCheckpointV1!({
      authority,
      aggregate,
      checkpoint,
      relevantChildren: [{
        authority: childAuthority,
        aggregate: { ...childAggregate, eventPosition: 10n },
      }],
    }), /CHECKPOINT_BASE_INVALID/u);
  });
});

describe("CheckpointService transactional enrichment", () => {
  it("dispatches checkpoint preparation once on checkpointVersion", async () => {
    const version1 = await checkpointServiceFixture();
    const version2 = await checkpointServiceFixture();
    try {
      const v1Effect = version1.service.record(
        version1.harness.transaction,
        checkpointCommand({ draft: decodeCheckpointDraftV1(draft()) }),
      );
      const v2Effect = version2.service.record(
        version2.harness.transaction,
        checkpointCommand({
          commandId: "77777777-7777-4777-8777-777777777777",
          idempotencyKey: "checkpoint-test/v2",
          draft: decodeCheckpointDraftV2(qualifiedDraft()),
        }) as unknown as RecordCheckpointCommandV3,
      );

      assert.equal(v1Effect.append.publicResponse.checkpointVersion, 1);
      assert.equal(v2Effect.append.publicResponse.checkpointVersion, 2);
      assert.equal(v1Effect.append.events[0]?.eventSchemaVersion, 1);
      assert.equal(v2Effect.append.events[0]?.eventSchemaVersion, 2);
      assert.deepEqual(version1.harness.calls.version1Eligibility, [[ROOT_ID]]);
      assert.deepEqual(version1.harness.calls.version2Snapshots, []);
      assert.deepEqual(version2.harness.calls.version1Eligibility, []);
      assert.deepEqual(version2.harness.calls.version2Snapshots, [{
        sessionId: ROOT_ID,
        baseEventPosition: 50n,
      }]);
    } finally {
      version1.cleanup();
      version2.cleanup();
    }
  });

  it("prepares root suspension with complete Version 1 ending-scope eligibility", async () => {
    const fixture = await checkpointServiceFixture();
    try {
      const command = Object.freeze({
        commandType: "root-suspend",
        commandId: COMMAND_ID,
        idempotencyKey: "checkpoint-test/root-suspension",
        agentId: "agent-checkpoint",
        expectedProjectId: PROJECT_ID,
        expectedVaultId: VAULT_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedBranchRef: "refs/heads/current",
        sessionId: ROOT_ID,
        expectedStreamVersion: "3",
        checkpoint: decodeCheckpointDraftV1(draft()),
      });

      const prepared = fixture.service.prepareRootSuspension(
        fixture.harness.transaction,
        {
          context: fixture.context,
          command,
          sourceStateScope: fixture.scope,
          authority: fixture.harness.root,
          aggregate: fixture.harness.rootAggregate,
          baseEventPosition: 50n,
          checkpointEventPosition: 51n,
          createdAt: CREATED_AT,
        },
      );

      assert.equal(prepared.checkpoint.checkpointVersion, 1);
      assert.equal(prepared.event.eventSchemaVersion, 1);
      assert.deepEqual(fixture.harness.calls.version1Eligibility, [[
        ROOT_ID,
        CHILD_ID,
        "99999999-9999-4999-8999-999999999999",
      ]]);
      assert.deepEqual(fixture.harness.calls.version2Snapshots, []);
      assert.equal(fixture.harness.calls.sourceCaptures.length, 1);
      assert.equal(fixture.harness.calls.identities.length, 1);
      assert.equal(
        prepared.checkpointFingerprint,
        createHash("sha256")
          .update("project-memory/checkpoint/v1\n", "utf8")
          .update(canonicalJson(prepared.checkpoint), "utf8")
          .digest("hex"),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("retains deterministic overlapping adapter coverage and latest batch linkage", async () => {
    const adapter = (
      adapterSessionId: string,
      highestContiguousOrdinal: string,
      missingIntervals: readonly Readonly<Record<string, string>>[],
      latestBatchId: string,
      latestBatchEventPosition: string,
    ) => Object.freeze({
      adapterSessionId,
      coverageFirstOrdinal: "0",
      coverageLastOrdinal: "2",
      highestContiguousOrdinal,
      missingIntervals: Object.freeze(missingIntervals),
      frameFingerprintAlgorithm: "hmac-sha256",
      frameFingerprintSchemaVersion: 1,
      frameFingerprintKeyId: "coverage-key-1",
      frameFingerprintDomain: "pm-evidence-frame-v1",
      coverageFingerprintAlgorithm: "hmac-sha256",
      coverageFingerprintSchemaVersion: 1,
      coverageFingerprintKeyId: "coverage-key-1",
      coverageFingerprintDomain: "pm-evidence-coverage-v1",
      coverageFingerprint: "a".repeat(64),
      latestBatchId,
      latestBatchEventPosition,
    });
    const snapshot = Object.freeze({
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: Object.freeze([
        adapter(
          "11111111-1111-4111-8111-111111111111",
          "0",
          [{ firstOrdinal: "1", lastOrdinal: "2" }],
          "88888888-8888-4888-8888-888888888888",
          "42",
        ),
        adapter(
          "22222222-2222-4222-8222-222222222222",
          "2",
          [],
          "99999999-9999-4999-8999-999999999999",
          "49",
        ),
      ]),
    });
    const fixture = await checkpointServiceFixture({ snapshot });
    try {
      const effect = fixture.service.record(fixture.harness.transaction, checkpointCommand({
        commandId: "77777777-7777-4777-8777-777777777777",
        idempotencyKey: "checkpoint-test/v2-overlap",
        draft: qualifiedDraft(),
      }));
      const event = effect.append.events[0] as {
        readonly payload: { readonly checkpoint: Readonly<Record<string, unknown>> };
      };
      assert.deepEqual(event.payload.checkpoint.evidenceCoverage, snapshot);
    } finally {
      fixture.cleanup();
    }
  });

  it("prepares a manual child checkpoint through the shared version-aware path", async () => {
    const version1 = await checkpointServiceFixture({ target: "child" });
    const version2 = await checkpointServiceFixture({ target: "child" });
    try {
      const v1 = version1.service.record(
        version1.harness.transaction,
        childCheckpointCommand(),
      );
      const v2 = version2.service.record(
        version2.harness.transaction,
        childCheckpointCommand({
          commandId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          idempotencyKey: "checkpoint-test/child-v2",
          draft: qualifiedDraft(),
        }),
      );
      for (const effect of [v1, v2]) {
        const checkpoint = (effect.append.events[0] as {
          readonly payload: { readonly checkpoint: Readonly<Record<string, unknown>> };
        }).payload.checkpoint;
        assert.equal(checkpoint.sessionId, CHILD_ID);
        assert.equal(checkpoint.parentSessionId, ROOT_ID);
        assert.deepEqual(checkpoint.childSummaries, []);
      }
      assert.deepEqual(version1.harness.calls.version1Eligibility, [[CHILD_ID]]);
      assert.deepEqual(version2.harness.calls.version2Snapshots, [{
        sessionId: CHILD_ID,
        baseEventPosition: 50n,
      }]);
      assert.equal(version1.harness.calls.childLists.length, 0);
      assert.equal(version2.harness.calls.childLists.length, 0);
    } finally {
      version1.cleanup();
      version2.cleanup();
    }
  });

  it("rejects unavailable checkpoint evidence keys before source, clock, or UUID work", async () => {
    const unavailable = new Error("EVIDENCE_FINGERPRINT_KEY_UNAVAILABLE");
    const version1 = await checkpointServiceFixture({ eligibilityError: unavailable });
    const version2 = await checkpointServiceFixture({ snapshotError: unavailable });
    try {
      assert.throws(
        () => version1.service.record(version1.harness.transaction, checkpointCommand()),
        /EVIDENCE_FINGERPRINT_KEY_UNAVAILABLE/u,
      );
      assert.throws(
        () => version2.service.record(
          version2.harness.transaction,
          checkpointCommand({
            commandId: "77777777-7777-4777-8777-777777777777",
            idempotencyKey: "checkpoint-test/v2-unavailable",
            draft: qualifiedDraft(),
          }),
        ),
        /EVIDENCE_FINGERPRINT_KEY_UNAVAILABLE/u,
      );
      for (const fixture of [version1, version2]) {
        assert.equal(fixture.harness.calls.sourceCaptures.length, 0);
        assert.equal(fixture.harness.calls.clocks.length, 0);
        assert.equal(fixture.harness.calls.identities.length, 0);
        assert.deepEqual(fixture.harness.calls.foldReads, [ROOT_ID]);
        assert.equal(fixture.harness.calls.latestCheckpointReads.length, 1);
        assert.equal(fixture.harness.calls.childLists.length, 0);
      }
    } finally {
      version1.cleanup();
      version2.cleanup();
    }
  });

  it("owns each final checkpoint preparation in one transaction and consumes it once", async () => {
    const fixture = await checkpointServiceFixture();
    try {
      const command = checkpointCommand() as unknown as RecordCheckpointCommandV2;
      const prepared = fixture.service.prepareFinalPhase(fixture.harness.transaction, {
        command,
        materializationTarget: "memory/final.md",
      });
      assert.equal(prepared.action.action, "record-final-checkpoint-and-queue-ending");
      if (prepared.action.action !== "record-final-checkpoint-and-queue-ending") {
        throw new Error("unexpected final checkpoint action");
      }
      assert.equal(
        prepared.action.finalCheckpoint.checkpointVersion,
        1,
      );
      assert.equal(prepared.action.materializationTarget, "memory/final.md");
      assert.equal(
        (fixture.harness.calls.sourceCaptures[0] as Readonly<Record<string, unknown>>).final,
        true,
      );

      const foreignTransaction = Object.freeze({ ...fixture.harness.transaction });
      assert.throws(
        () => fixture.service.recordPreparedFinal(foreignTransaction, prepared),
        /INTEGRITY_FAILURE/u,
      );
      assert.throws(
        () => fixture.service.recordPreparedFinal(
          fixture.harness.transaction,
          { ...prepared },
        ),
        /INTEGRITY_FAILURE/u,
      );
      assert.equal(
        fixture.service.recordPreparedFinal(fixture.harness.transaction, prepared),
        prepared.effect,
      );
      assert.throws(
        () => fixture.service.recordPreparedFinal(fixture.harness.transaction, prepared),
        /INTEGRITY_FAILURE/u,
      );
      assert.throws(
        () => fixture.service.prepareFinalPhase(fixture.harness.transaction, {
          command,
          materializationTarget: "memory/final.md",
          finalCheckpointId: CHECKPOINT_ID,
        }),
        /LIFECYCLE_INPUT_INVALID/u,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("accepts only snapshotted own-data final inputs at the phase target bound", async () => {
    const fixture = await checkpointServiceFixture();
    let getterReads = 0;
    try {
      const accessorInput = {};
      Object.defineProperties(accessorInput, {
        command: {
          enumerable: true,
          get: () => {
            getterReads += 1;
            return checkpointCommand();
          },
        },
        materializationTarget: {
          enumerable: true,
          value: "memory/final.md",
        },
      });
      assert.throws(
        () => fixture.service.prepareFinalPhase(
          fixture.harness.transaction,
          accessorInput,
        ),
        /LIFECYCLE_INPUT_INVALID/u,
      );
      assert.equal(getterReads, 0);
      assert.throws(
        () => fixture.service.prepareFinalPhase(fixture.harness.transaction, {
          command: checkpointCommand(),
          materializationTarget: "x".repeat(1_025),
        }),
        /LIFECYCLE_INPUT_INVALID/u,
      );
      assert.equal(fixture.harness.calls.sourceCaptures.length, 0);

      const prepared = fixture.service.prepareFinalPhase(fixture.harness.transaction, {
        command: checkpointCommand(),
        materializationTarget: "x".repeat(1_024),
      });
      if (prepared.action.action !== "record-final-checkpoint-and-queue-ending") {
        throw new Error("unexpected final checkpoint action");
      }
      assert.equal(prepared.action.materializationTarget.length, 1_024);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a prepared final capability after its guarded callback closes", async () => {
    const fixture = await checkpointServiceFixture();
    let active = true;
    const guardedTransaction = new Proxy(fixture.harness.transaction, {
      get(target, property, receiver) {
        if (!active) throw new Error("STALE_TRANSACTION_CALLBACK");
        return Reflect.get(target, property, receiver) as unknown;
      },
      ownKeys(target) {
        if (!active) throw new Error("STALE_TRANSACTION_CALLBACK");
        return Reflect.ownKeys(target);
      },
    });
    try {
      const prepared = fixture.service.prepareFinalPhase(guardedTransaction, {
        command: checkpointCommand(),
        materializationTarget: "memory/final.md",
      });
      active = false;
      assert.throws(
        () => fixture.service.recordPreparedFinal(guardedTransaction, prepared),
        /STALE_TRANSACTION_CALLBACK/u,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("deep-freezes the prepared final effect against cast mutation", async () => {
    const fixture = await checkpointServiceFixture();
    try {
      const prepared = fixture.service.prepareFinalPhase(fixture.harness.transaction, {
        command: checkpointCommand(),
        materializationTarget: "memory/final.md",
      });
      assert.equal(Object.isFrozen(prepared.effect), true);
      assert.equal(Object.isFrozen(prepared.effect.append), true);
      assert.equal(Object.isFrozen(prepared.effect.append.events), true);
      const pendingEvent = prepared.effect.append.events[0] as unknown as {
        readonly payload: {
          readonly checkpoint: {
            readonly taskSummary: string;
          };
        };
      };
      assert.equal(Object.isFrozen(pendingEvent), true);
      assert.equal(Object.isFrozen(pendingEvent.payload), true);
      assert.equal(Object.isFrozen(pendingEvent.payload.checkpoint), true);
      assert.throws(() => {
        (prepared.effect as unknown as {
          afterAppend: () => void;
        }).afterAppend = () => undefined;
      }, TypeError);
      assert.throws(() => {
        (prepared.effect.append as unknown as {
          events: readonly unknown[];
        }).events = [];
      }, TypeError);
      assert.throws(() => {
        (pendingEvent.payload.checkpoint as {
          taskSummary: string;
        }).taskSummary = "cast mutation";
      }, TypeError);
      assert.equal(
        fixture.service.recordPreparedFinal(fixture.harness.transaction, prepared),
        prepared.effect,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("prepares a full qualified final action from only the stable draft and target", async () => {
    const fixture = await checkpointServiceFixture();
    try {
      const command = checkpointCommand({
        commandId: "77777777-7777-4777-8777-777777777777",
        idempotencyKey: "checkpoint-test/v2-final",
        draft: qualifiedDraft(),
      }) as unknown as RecordCheckpointCommandV3;
      const prepared = fixture.service.prepareFinalPhase(fixture.harness.transaction, {
        command,
        materializationTarget: "memory/qualified-final.md",
      });
      if (prepared.action.action !== "record-final-checkpoint-and-queue-ending") {
        throw new Error("unexpected final checkpoint action");
      }
      const checkpoint = prepared.action.finalCheckpoint;
      assert.equal(checkpoint.checkpointVersion, 2);
      assert.deepEqual(checkpoint.evidenceCoverage, {
        coverageVersion: 2,
        captureMode: "coverage-only",
        contentRetained: false,
        adapterSessions: [],
      });
      assert.equal(
        fixture.service.recordPreparedFinal(fixture.harness.transaction, prepared),
        prepared.effect,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("derives the base, event position, source witness, coverage, and root child summaries", async () => {
    const fixture = await checkpointServiceFixture();
    try {
      const effect = fixture.service.record(fixture.harness.transaction, checkpointCommand());
      assert.equal(effect.append.events.length, 1);
      const event = effect.append.events[0] as {
        readonly eventType: unknown;
        readonly payload: {
          readonly baseEventPosition: unknown;
          readonly checkpointEventPosition: unknown;
          readonly checkpoint: Readonly<Record<string, unknown>>;
        };
      };
      assert.equal(event.eventType, "SessionCheckpointRecorded");
      assert.equal(event.payload.baseEventPosition, "50");
      assert.equal(event.payload.checkpointEventPosition, "51");
      assert.equal(event.payload.checkpoint.checkpointId, CHECKPOINT_ID);
      assert.equal(event.payload.checkpoint.createdAt, CREATED_AT);
      assert.equal(event.payload.checkpoint.creatorAgentId, "agent-checkpoint");
      assert.equal(event.payload.checkpoint.creatorClientInstanceId, "primary-client");
      assert.deepEqual(event.payload.checkpoint.childSummaries, [{
        childSessionId: CHILD_ID,
        state: "active",
        lastEventPosition: "40",
        streamVersion: "2",
        latestCheckpointId: null,
      }]);
      assert.deepEqual(event.payload.checkpoint.evidenceCoverage, {
        captureMode: "coverage-only",
        contentRetained: false,
        highestContiguousOrdinal: null,
        missingIntervals: [],
      });
      assert.equal(fixture.harness.calls.sourceCaptures.length, 1);
      assert.equal(effect.append.publicResponse.baseEventPosition, "50");
      assert.equal(effect.append.publicResponse.checkpointEventPosition, "51");
      assert.equal(effect.append.publicResponse.finalStreamVersion, "4");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects stale stream and base assertions before source-state capture", async () => {
    const fixture = await checkpointServiceFixture();
    try {
      assert.throws(
        () => fixture.service.record(fixture.harness.transaction, checkpointCommand({ expectedStreamVersion: "2" })),
        /EVENT_CONFLICT/u,
      );
      assert.throws(
        () => fixture.service.record(fixture.harness.transaction, checkpointCommand({ expectedBaseEventPosition: "49" })),
        /EVENT_CONFLICT/u,
      );
      assert.equal(fixture.harness.calls.sourceCaptures.length, 0);
      assert.equal(fixture.harness.calls.checkpointUpdates.length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a corrupt existing checkpoint fingerprint before enrichment or mutation", async () => {
    const fixture = await checkpointServiceFixture({ corruptLatestCheckpointFingerprint: true });
    try {
      assert.throws(
        () => fixture.service.record(fixture.harness.transaction, checkpointCommand()),
        /INTEGRITY_FAILURE/u,
      );
      assert.equal(fixture.harness.calls.latestCheckpointReads.length, 1);
      assert.equal(fixture.harness.calls.sourceCaptures.length, 0);
      assert.equal(fixture.harness.calls.checkpointUpdates.length, 0);
      assert.equal(fixture.harness.calls.clears.length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a corrupt nonterminal child checkpoint fingerprint before root enrichment", async () => {
    const fixture = await checkpointServiceFixture({ corruptChildLatestCheckpointFingerprint: true });
    try {
      assert.throws(
        () => fixture.service.record(fixture.harness.transaction, checkpointCommand()),
        (error: unknown) => (error as { readonly code?: unknown }).code === "INTEGRITY_FAILURE",
      );
      assert.equal(fixture.harness.calls.latestCheckpointReads.length, 2);
      assert.equal(fixture.harness.calls.sourceCaptures.length, 0);
      assert.equal(fixture.harness.calls.checkpointUpdates.length, 0);
      assert.equal(fixture.harness.calls.clears.length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a file assertion whose branch differs from the trusted source witness", async () => {
    const fixture = await checkpointServiceFixture();
    try {
      const maliciousDraft = {
        ...draft(),
        filesTouched: [{
          path: "src/observed.ts",
          action: "observed",
          contentHash: null,
          branchRef: "refs/heads/caller-selected",
          confidence: "high",
        }],
      };
      assert.throws(
        () => fixture.service.record(
          fixture.harness.transaction,
          checkpointCommand({ draft: maliciousDraft }),
        ),
        /LIFECYCLE_INPUT_INVALID/u,
      );
      assert.equal(fixture.harness.calls.sourceCaptures.length, 1);
      assert.equal(fixture.harness.calls.checkpointUpdates.length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("updates the specialized checkpoint index and clears only a covered marker after append", async () => {
    const fixture = await checkpointServiceFixture({ markerPosition: 41n });
    try {
      const expectedFingerprint =
        "a24657fd1bedcb0af8f229c62e472e603085f159768dfa4c04d355dc11d8cf2e";
      const effect = fixture.service.record(fixture.harness.transaction, checkpointCommand());
      assert.equal(effect.append.publicResponse.checkpointRequiredCleared, true);
      assert.equal(fixture.harness.calls.checkpointUpdates.length, 0);
      assert.equal(fixture.harness.calls.clears.length, 0);

      effect.afterAppend(committedCheckpointBatch(), fixture.harness.transaction);

      assert.deepEqual(fixture.harness.calls.checkpointUpdates, [{
        projectId: PROJECT_ID,
        sessionId: ROOT_ID,
        expectedLatestCheckpointId: null,
        expectedLatestCheckpointEventPosition: null,
        expectedLatestCheckpointFingerprint: null,
        checkpointId: CHECKPOINT_ID,
        checkpointEventPosition: 51n,
        checkpointFingerprint: expectedFingerprint,
        updatedAt: CREATED_AT,
      }]);
      assert.deepEqual(fixture.harness.calls.clears, [{
        projectId: PROJECT_ID,
        sessionId: ROOT_ID,
        checkpointBaseEventPosition: 50n,
        updatedAt: CREATED_AT,
      }]);
    } finally {
      fixture.cleanup();
    }
  });

  it("uses the same checkpoint-index CAS and marker clear for Version 2", async () => {
    const fixture = await checkpointServiceFixture({ markerPosition: 41n });
    try {
      const effect = fixture.service.record(fixture.harness.transaction, checkpointCommand({
        commandId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        idempotencyKey: "checkpoint-test/v2-marker",
        draft: qualifiedDraft(),
      }));
      const expectedFingerprint =
        "e6ecf25b9fe21a423a9a55570656d8a1f1f61e6242f1524cb38d0edde0309fe5";
      assert.equal(effect.append.publicResponse.checkpointVersion, 2);
      assert.equal(effect.append.publicResponse.checkpointRequiredCleared, true);
      effect.afterAppend(committedCheckpointBatch(), fixture.harness.transaction);
      assert.deepEqual(fixture.harness.calls.checkpointUpdates, [{
        projectId: PROJECT_ID,
        sessionId: ROOT_ID,
        expectedLatestCheckpointId: null,
        expectedLatestCheckpointEventPosition: null,
        expectedLatestCheckpointFingerprint: null,
        checkpointId: CHECKPOINT_ID,
        checkpointEventPosition: 51n,
        checkpointFingerprint: expectedFingerprint,
        updatedAt: CREATED_AT,
      }]);
      assert.deepEqual(fixture.harness.calls.clears, [{
        projectId: PROJECT_ID,
        sessionId: ROOT_ID,
        checkpointBaseEventPosition: 50n,
        updatedAt: CREATED_AT,
      }]);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not record or clear a checkpoint based before the triggering marker", async () => {
    const fixture = await checkpointServiceFixture({ basePosition: 40n, markerPosition: 41n });
    try {
      assert.throws(
        () => fixture.service.record(
          fixture.harness.transaction,
          checkpointCommand({ expectedBaseEventPosition: "40" }),
        ),
        /CHECKPOINT_BASE_INVALID/u,
      );
      assert.equal(fixture.harness.calls.sourceCaptures.length, 0);
      assert.equal(fixture.harness.calls.checkpointUpdates.length, 0);
      assert.equal(fixture.harness.calls.clears.length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("leaves the existing marker untouched when a crash occurs before checkpoint-index CAS", async () => {
    const fixture = await checkpointServiceFixture({ markerPosition: 41n, faultPoint: "before-checkpoint-index-cas" });
    try {
      const effect = fixture.service.record(fixture.harness.transaction, checkpointCommand());
      assert.throws(
        () => effect.afterAppend(committedCheckpointBatch(), fixture.harness.transaction),
        /INJECTED_CHECKPOINT_CRASH/u,
      );
      assert.equal(fixture.harness.calls.checkpointUpdates.length, 0);
      assert.equal(fixture.harness.calls.clears.length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("surfaces a crash between checkpoint-index CAS and marker clearing", async () => {
    const fixture = await checkpointServiceFixture({
      markerPosition: 41n,
      faultPoint: "after-checkpoint-index-before-marker-clear",
    });
    try {
      const effect = fixture.service.record(fixture.harness.transaction, checkpointCommand());
      assert.throws(
        () => effect.afterAppend(committedCheckpointBatch(), fixture.harness.transaction),
        /INJECTED_CHECKPOINT_CRASH/u,
      );
      assert.equal(fixture.harness.calls.checkpointUpdates.length, 1);
      assert.equal(fixture.harness.calls.clears.length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("executes stable internal final-checkpoint plans only on fresh V1/V2 callbacks", async () => {
    for (const checkpointVersion of [1, 2] as const) {
      const plan = internalFinalCheckpointPlan(checkpointVersion);
      const envelopeFor = (context: ProjectContext) => internalPlanEnvelope(context, plan);
      const replayFixture = await checkpointServiceFixture({
        authorizationRecord: internalPlanAuthorization(plan),
        freshCapabilityGeneration: null,
      });
      try {
        const connection = new InternalPlanStoreConnection();
        const events = new InternalPlanEvents(internalPlanReplay(plan));
        let transactionConstructions = 0;
        let preparations = 0;
        let consumptions = 0;
        const store = new LifecycleCommandStore({
          connection,
          events,
          transaction: () => {
            transactionConstructions += 1;
            throw new Error("replay must not construct a transaction facade");
          },
          now: () => CREATED_AT,
        });
        const replayed = store.execute(envelopeFor(replayFixture.context), (transaction) => {
          preparations += 1;
          const prepared = replayFixture.service.prepareFinalPhase(transaction, {
            command: checkpointCommandFromPlan(plan),
            materializationTarget: plan.plannedAction.action
                === "prepare-final-checkpoint-and-queue-ending"
              ? plan.plannedAction.materializationTarget
              : "unreachable",
          });
          consumptions += 1;
          return adaptPreparedInternalCommit(
            replayFixture.service.recordPreparedFinal(transaction, prepared),
          );
        });

        assert.equal(replayed.deduplicated, true);
        assert.equal(transactionConstructions, 0);
        assert.equal(preparations, 0);
        assert.equal(consumptions, 0);
        assert.equal(replayFixture.harness.calls.sourceCaptures.length, 0);
        assert.deepEqual(events.calls, ["find-replay"]);
        assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
      } finally {
        replayFixture.cleanup();
      }

      const freshFixture = await checkpointServiceFixture({
        authorizationRecord: internalPlanAuthorization(plan),
        freshCapabilityGeneration: null,
      });
      try {
        const connection = new InternalPlanStoreConnection();
        const events = new InternalPlanEvents(null);
        const sequence: string[] = [];
        let preparations = 0;
        let consumptions = 0;
        const store = new LifecycleCommandStore({
          connection,
          events,
          transaction: () => completeCheckpointTransaction(freshFixture.harness),
          now: () => CREATED_AT,
        });
        const committed = store.execute(envelopeFor(freshFixture.context), (transaction) => {
          const checkpointCommand = checkpointCommandFromPlan(plan);
          const prepared = freshFixture.service.prepareFinalPhase(transaction, {
            command: checkpointCommand,
            materializationTarget: plan.plannedAction.action
                === "prepare-final-checkpoint-and-queue-ending"
              ? plan.plannedAction.materializationTarget
              : "unreachable",
          });
          preparations += 1;
          sequence.push("prepared");

          const { plannedAction: _plannedAction, ...stablePlan } = plan;
          const authoritativeCommand: InternalWorkflowPhaseCommand = {
            ...stablePlan,
            action: prepared.action,
          };
          assert.equal(authoritativeCommand.action.action, "record-final-checkpoint-and-queue-ending");
          if (authoritativeCommand.action.action !== "record-final-checkpoint-and-queue-ending"
            || plan.plannedAction.action !== "prepare-final-checkpoint-and-queue-ending") {
            throw new Error("unexpected internal final-checkpoint action");
          }
          assert.equal(
            authoritativeCommand.action.finalCheckpoint.checkpointVersion,
            plan.plannedAction.finalCheckpointDraft.checkpointVersion,
          );
          assert.doesNotThrow(() => buildLifecycleIntentWitness(
            authoritativeCommand,
            internalPlanAssertions(plan),
          ));
          sequence.push(`authoritative-v${checkpointVersion}`);

          const effect = freshFixture.service.recordPreparedFinal(transaction, prepared);
          consumptions += 1;
          sequence.push("consumed");
          return adaptPreparedInternalCommit(effect);
        });

        assert.equal(committed.deduplicated, false);
        assert.equal(preparations, 1);
        assert.equal(consumptions, 1);
        assert.deepEqual(sequence, [
          "prepared",
          `authoritative-v${checkpointVersion}`,
          "consumed",
        ]);
        assert.equal(
          (committed.publicResult as Readonly<Record<string, unknown>>).checkpointVersion,
          checkpointVersion,
        );
        assert.deepEqual(freshFixture.harness.calls.version1Eligibility,
          checkpointVersion === 1 ? [[ROOT_ID]] : []);
        assert.deepEqual(freshFixture.harness.calls.version2Snapshots,
          checkpointVersion === 2
            ? [{ sessionId: ROOT_ID, baseEventPosition: 50n }]
            : []);
        assert.deepEqual(events.insertedAuthorizations, [internalPlanAuthorization(plan)]);
        assert.deepEqual(connection.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
      } finally {
        freshFixture.cleanup();
      }
    }
  });

  it("rejects an unconsumed prepared final capability after a real store callback closes", async () => {
    const plan = internalFinalCheckpointPlan(1);
    const fixture = await checkpointServiceFixture({
      authorizationRecord: internalPlanAuthorization(plan),
      freshCapabilityGeneration: null,
    });
    let guardedTransaction: LifecycleCommandTransaction | undefined;
    let unconsumed: ReturnType<CheckpointServiceLike["prepareFinalPhase"]> | undefined;
    try {
      const connection = new InternalPlanStoreConnection();
      const events = new InternalPlanEvents(null);
      const store = new LifecycleCommandStore({
        connection,
        events,
        transaction: () => completeCheckpointTransaction(fixture.harness),
        now: () => CREATED_AT,
      });
      store.execute(internalPlanEnvelope(fixture.context, plan), (transaction) => {
        guardedTransaction = transaction;
        unconsumed = fixture.service.prepareFinalPhase(transaction, {
          command: checkpointCommandFromPlan(plan),
          materializationTarget: "memory/final.md",
        });
        return adaptPreparedInternalCommit(unconsumed.effect);
      });
      assert.notEqual(guardedTransaction, undefined);
      assert.notEqual(unconsumed, undefined);
      assert.throws(
        () => fixture.service.recordPreparedFinal(guardedTransaction!, unconsumed!),
        /LIFECYCLE_INPUT_INVALID/u,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("returns an exact stored checkpoint retry before invoking enrichment", async () => {
    const fixture = await checkpointServiceFixture();
    try {
      const command = checkpointCommand() as unknown as RecordCheckpointCommandV2;
      const principal = Object.freeze({ actorRole: "primary" as const, clientInstanceId: "primary-client" });
      const replayExpectation = Object.freeze({
        kind: "protected" as const,
        proof: Object.freeze({ version: 1 as const, nonce: "88888888-8888-4888-8888-888888888888", digest: "8".repeat(64) }),
        approval: null,
        authorizationSessionId: ROOT_ID,
        targetSessionId: ROOT_ID,
        presenting: principal,
        target: principal,
      });
      const authorization = replayExpectation as PersistedLifecycleAuthorizationRecord;
      const witness = buildLifecycleIntentWitness(command, {
        authorizationKind: "protected",
        authorizationSessionId: ROOT_ID,
        targetSessionId: ROOT_ID,
        projectId: PROJECT_ID,
        vaultId: VAULT_ID,
        storeId: STORE_ID,
        workspaceId: WORKSPACE_ID,
        clientNamespace: "tests",
        capabilityKind: "root-session-handle",
        capabilityGeneration: "1",
        presentingActorRole: "primary",
        presentingClientInstanceId: "primary-client",
        targetActorRole: "primary",
        targetClientInstanceId: "primary-client",
        internalWorkflowId: null,
        internalWorkflowGeneration: null,
        internalPlannedWorkId: null,
      });
      const response = Object.freeze({
        checkpointVersion: 1,
        checkpointId: CHECKPOINT_ID,
        sessionId: ROOT_ID,
        baseEventPosition: "50",
        checkpointEventPosition: "51",
        finalStreamVersion: "4",
        checkpointRequiredCleared: false,
      });
      const statements: string[] = [];
      const connection = {
        exec(sql: string) { statements.push(sql.trim().toUpperCase()); },
        prepare(): SqliteStatement { throw new Error("replay must not prepare SQL through the connection facade"); },
        close() {},
      } as SqliteConnection;
      const events = {
        findLifecycleReplay: () => ({
          deduplicated: true,
          firstGlobalPosition: 51n,
          lastGlobalPosition: 51n,
          finalStreamVersion: 4n,
          eventIds: ["99999999-9999-4999-8999-999999999999"],
          response,
          responseHash: "9".repeat(64),
          authorizationRecord: authorization,
        }),
      } as unknown as LifecycleEventAppendPort;
      const store = new LifecycleCommandStore({
        connection,
        events,
        transaction: () => { throw new Error("exact replay must not construct transaction facades"); },
      });
      const envelope: LifecycleCommandEnvelope = {
        context: fixture.context,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.commandType,
        candidateIntentHash: witness.intentHash,
        authoritativeIntentHash: witness.intentHash,
        semanticCommand: command,
        capabilityKind: "root-session-handle",
        capabilityGeneration: "1",
        replayExpectation,
      };
      let freshCallbacks = 0;

      const replay = store.execute(envelope, (transaction) => {
        freshCallbacks += 1;
        const prepared = fixture.service.prepareFinalPhase(transaction, {
          command,
          materializationTarget: "memory/final.md",
        });
        return fixture.service.recordPreparedFinal(
          transaction,
          prepared,
        ) as unknown as PreparedLifecycleCommit<JsonValue>;
      });

      assert.equal(replay.deduplicated, true);
      assert.deepEqual(replay.publicResult, response);
      assert.equal(freshCallbacks, 0);
      assert.equal(fixture.harness.calls.sourceCaptures.length, 0);
      assert.deepEqual(statements, ["BEGIN IMMEDIATE", "ROLLBACK"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a project-relative path whose existing symlink component escapes the project", async () => {
    const fixture = await checkpointServiceFixture();
    const outside = mkdtempSync(join(tmpdir(), "checkpoint-outside-"));
    try {
      symlinkSync(outside, join(fixture.context.binding.projectRoot, "linked-outside"), "junction");
      const unsafeDraft = {
        ...draft(),
        filesTouched: [{
          path: "linked-outside/secret.txt",
          action: "observed",
          contentHash: null,
          branchRef: null,
          confidence: "high",
        }],
      };
      assert.throws(
        () => fixture.service.record(
          fixture.harness.transaction,
          checkpointCommand({ draft: unsafeDraft }),
        ),
        /LIFECYCLE_INPUT_INVALID|PATH_OUTSIDE_ROOT/u,
      );
      assert.equal(fixture.harness.calls.sourceCaptures.length, 0);
    } finally {
      fixture.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
