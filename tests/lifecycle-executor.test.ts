import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import type {
  ProjectBinding,
  ProjectContext,
  ProjectId,
  StoreId,
  VaultId,
} from "../src/orchestrator/identity/contracts.js";
import { deriveNonGitWorkspaceId } from "../src/orchestrator/identity/git-workspace.resolver.js";
import { computeProjectContextFingerprint } from "../src/orchestrator/identity/project-binding.service.js";
import {
  AuthorityMaterialAdapter,
  type LifecycleExecutionResult,
  type PrivateAuthorityChannel,
  type RevalidatedTrustedLifecycleContext,
  type WorkerLifecycleResult,
} from "../src/orchestrator/lifecycle/authority/authority-material-adapter.js";
import { EncryptedPendingAuthorizationStore } from "../src/orchestrator/lifecycle/authority/encrypted-pending-authorization.store.js";
import type { PendingCommandIdentity } from "../src/orchestrator/lifecycle/authority/pending-authorization.store.js";
import { CapabilityService, type LifecycleAuthorityTarget, type RootOrChildAuthorityMaterial } from "../src/orchestrator/lifecycle/capability.service.js";
import type {
  CapabilityProofV1,
  InternalWorkflowExecutionPlan,
  LifecycleSemanticCommandDraft,
  PreparedLifecycleWorkerCommand,
} from "../src/orchestrator/lifecycle/contracts/commands.js";
import type { SessionId, WorkflowId } from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import type { SessionEndPhaseResultV2 } from "../src/orchestrator/lifecycle/contracts/session-end.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import type {
  RootLeaseRenewalResultV1,
  RootSessionPublicResultV2,
} from "../src/orchestrator/lifecycle/lifecycle-command.processor.js";
import type {
  SessionAssociationValidationV1,
  SessionStatusSummaryV1,
  SessionTreeSummaryV1,
} from "../src/orchestrator/lifecycle/lifecycle-query.service.js";
import {
  DEFAULT_MAX_PENDING,
  ProjectStoreExecutor,
  ProjectStoreWorkerError,
  type ExecutorScheduler,
  type ProjectStoreExecutorDependencies,
  type WorkerLike,
} from "../src/orchestrator/runtime/project-store-executor.js";
import type {
  LifecycleBoundedMutationInput,
  LifecycleFencedInput,
  LifecycleOutboxClaimWireV1,
  LifecycleQueryInput,
  LifecycleRecoveryScanResultWireV1,
  LifecycleWorkerSuccessWire,
  MaterializationResultWireV1,
  SessionEndWorkflowClaimWireV1,
} from "../src/orchestrator/runtime/lifecycle-worker-protocol.js";
import type {
  WorkerOpenResult,
  WorkerRequest,
} from "../src/orchestrator/runtime/worker-protocol.js";
import { canonicalMkdtemp } from "./support/canonical-temp.js";
import { DeterministicCapabilityKeyProvider } from "./support/lifecycle-authority-reference.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001" as ProjectId;
const VAULT_ID = "00000000-0000-4000-8000-000000000002" as VaultId;
const STORE_ID = "00000000-0000-4000-8000-000000000003" as StoreId;
const SESSION_ID = "00000000-0000-4000-8000-000000000010" as SessionId;
const WORKFLOW_ID = "00000000-0000-4000-8000-000000000011" as WorkflowId;
const COMMAND_ID = "00000000-0000-4000-8000-000000000020";
const OPERATION_ID = "00000000-0000-4000-8000-000000000021";
const REQUEST_ID = "00000000-0000-4000-8000-000000000022";
const WORK_ID = "work-selection-1";
const NOW = "2026-07-17T00:00:00.000Z";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const WORKER_URL = new URL("../src/workers/project-store.worker.js", import.meta.url);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = canonicalMkdtemp("lifecycle-executor-");
  roots.push(root);
  return root;
}

function contextFixture(root: string): ProjectContext {
  const projectRoot = resolve(root, "project");
  const vaultRoot = resolve(projectRoot, "memory");
  const storeRoot = resolve(vaultRoot, ".memory-mcp", "v2");
  mkdirSync(storeRoot, { recursive: true });
  const workspace = {
    kind: "non-git" as const,
    workspaceRoot: projectRoot,
    workspaceId: deriveNonGitWorkspaceId(PROJECT_ID, VAULT_ID),
  };
  const base: Omit<ProjectBinding, "contextFingerprint" | "projectBindingId" | "establishedAt"> = {
    generation: 1,
    source: "explicit-cli",
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: workspace.workspaceId,
    clientNamespace: "codex",
    clientInstanceId: "primary-a",
    actorRole: "primary",
    projectRoot,
    vaultRoot,
    descriptorPath: join(vaultRoot, ".memory-mcp", "project-identity.json"),
    storeRoute: {
      kind: "vault-local",
      storeRoot,
      eventsPath: join(storeRoot, "events.sqlite"),
      storeManifestPath: join(storeRoot, "store-manifest.json"),
      projectionManifestPath: join(storeRoot, "current-projection.json"),
    },
    workspace,
  };
  const binding: ProjectBinding = {
    ...base,
    projectBindingId: "00000000-0000-4000-8000-000000000090",
    contextFingerprint: computeProjectContextFingerprint(base),
    establishedAt: NOW,
  };
  return { binding, workspace, checkedAt: NOW };
}

class ManualScheduler implements ExecutorScheduler {
  readonly callbacks = new Map<object, () => void>();

  setTimeout(callback: () => void, _milliseconds: number): object {
    const handle = {};
    this.callbacks.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: object): void {
    this.callbacks.delete(handle);
  }

  runNext(): void {
    const next = this.callbacks.entries().next();
    if (next.done) throw new Error("NO_TIMER_AVAILABLE");
    const [handle, callback] = next.value;
    this.callbacks.delete(handle);
    callback();
  }
}

class FakeWorker extends EventEmitter implements WorkerLike {
  readonly posted: WorkerRequest[] = [];
  terminateCalls = 0;
  throwOnPost = false;

  postMessage(value: unknown): void {
    if (this.throwOnPost) throw new Error("synchronous post failure");
    this.posted.push(value as WorkerRequest);
  }

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    return 1;
  }

  succeed(request: WorkerRequest, data: unknown): void {
    this.emit("message", { id: request.id, ok: true, data });
  }

  fail(request: WorkerRequest, code: string, details: unknown = {}): void {
    this.emit("message", {
      id: request.id,
      ok: false,
      error: { code, message: code, details },
    });
  }
}

class Nonces {
  #next = 100;

  bytes(length: number): Uint8Array {
    return Buffer.alloc(length, this.#next++ & 0xff);
  }

  uuid(): string {
    return `00000000-0000-4000-8000-${String(this.#next++).padStart(12, "0")}`;
  }
}

class NoopChannel implements PrivateAuthorityChannel {
  isAttached(_target: LifecycleAuthorityTarget): boolean { return false; }
  isLocalTarget(_target: LifecycleAuthorityTarget): boolean { return false; }
  async deliverLocal(_target: LifecycleAuthorityTarget, _material: RootOrChildAuthorityMaterial): Promise<void> {}
  async routeDescriptor(): Promise<void> {}
}

class RecordingAuthorityMaterialAdapter extends AuthorityMaterialAdapter {
  readonly completionIdentities: PendingCommandIdentity[] = [];

  override async complete<T extends JsonValue>(
    identity: PendingCommandIdentity,
    result: WorkerLifecycleResult<T>,
  ): Promise<LifecycleExecutionResult<T>> {
    this.completionIdentities.push(identity);
    return super.complete(identity, result);
  }
}

function adapterFixture(root: string, context: ProjectContext): {
  adapter: RecordingAuthorityMaterialAdapter;
  pending: EncryptedPendingAuthorizationStore;
} {
  const provider = new DeterministicCapabilityKeyProvider();
  const nonces = new Nonces();
  const privateStateRoot = resolve(root, "host-private");
  mkdirSync(privateStateRoot, { recursive: true });
  const pending = new EncryptedPendingAuthorizationStore({
    privateStateRoot,
    scope: { projectId: context.binding.projectId, storeId: context.binding.storeId },
    keyProvider: provider,
  });
  const adapter = new RecordingAuthorityMaterialAdapter({
    pendingStore: pending,
    keyProvider: provider,
    capabilityService: new CapabilityService({
      keyProvider: provider,
      clock: { nowMs: () => BigInt(Date.parse(NOW)) },
      nonceSource: nonces,
    }),
    channel: new NoopChannel(),
    clock: { nowMs: () => BigInt(Date.parse(NOW)) },
    nonceSource: nonces,
  });
  return { adapter, pending };
}

interface Harness {
  readonly root: string;
  readonly context: ProjectContext;
  readonly worker: FakeWorker;
  readonly scheduler: ManualScheduler;
  readonly executor: ProjectStoreExecutor;
  readonly adapter: RecordingAuthorityMaterialAdapter | null;
  readonly pending: EncryptedPendingAuthorizationStore | null;
}

function openResult(context: ProjectContext): WorkerOpenResult {
  return {
    projectId: context.binding.projectId,
    vaultId: context.binding.vaultId,
    storeId: context.binding.storeId,
    bindingGeneration: context.binding.generation,
    contextFingerprint: context.binding.contextFingerprint,
    executorId: "00000000-0000-4000-8000-000000000099",
  };
}

async function harness(withAdapter = false): Promise<Harness> {
  const root = temporaryRoot();
  const context = contextFixture(root);
  writeFileSync(context.binding.storeRoute.eventsPath, "fixture", "utf8");
  const worker = new FakeWorker();
  const scheduler = new ManualScheduler();
  const authority = withAdapter ? adapterFixture(root, context) : null;
  const dependencies: Partial<ProjectStoreExecutorDependencies> = {
    workerFactory: () => worker,
    scheduler,
    randomId: () => "00000000-0000-4000-8000-000000000098",
    ...(authority === null ? {} : { authorityMaterialAdapter: authority.adapter }),
  };
  const executor = new ProjectStoreExecutor({
    workerUrl: WORKER_URL,
    context,
    maxPending: DEFAULT_MAX_PENDING,
    requestTimeoutMs: 10_000,
    closeTimeoutMs: 5_000,
    executorLeaseMs: 15_000,
    heartbeatIntervalMs: 5_000,
  }, dependencies);
  const opening = executor.open();
  const request = worker.posted.at(-1);
  assert.equal(request?.type, "open");
  worker.succeed(request!, openResult(context));
  await opening;
  return {
    root,
    context,
    worker,
    scheduler,
    executor,
    adapter: authority?.adapter ?? null,
    pending: authority?.pending ?? null,
  };
}

function trustedContext(context: ProjectContext): RevalidatedTrustedLifecycleContext {
  return {
    context,
    authoritySessionId: null,
    targetSessionId: null,
    capabilityKind: null,
    capabilityGeneration: null,
    authorityTarget: { actorRole: "primary", clientInstanceId: context.binding.clientInstanceId },
    targetBindingFingerprint: null,
  };
}

function rootStart(context: ProjectContext, commandId = COMMAND_ID): LifecycleSemanticCommandDraft {
  return {
    commandType: "root-start",
    commandId,
    idempotencyKey: `root-start/${commandId}`,
    agentId: "agent-primary",
    expectedProjectId: context.binding.projectId,
    expectedVaultId: context.binding.vaultId,
    expectedWorkspaceId: context.binding.workspaceId,
    expectedBranchRef: null,
    continuityKey: "executor-identity-test",
    resumePolicy: "new",
  };
}

async function prepareRoot(h: Harness, commandId = COMMAND_ID): Promise<PreparedLifecycleWorkerCommand<LifecycleSemanticCommandDraft>> {
  assert.ok(h.adapter !== null);
  return h.adapter.prepare(
    rootStart(h.context, commandId),
    { kind: "initial-authority" },
    trustedContext(h.context),
  );
}

function semanticSuccess(context: ProjectContext): LifecycleWorkerSuccessWire {
  const publicResult: RootSessionPublicResultV2 = {
    resultVersion: 2,
    project: {
      projectId: context.binding.projectId,
      vaultId: context.binding.vaultId,
      storeId: context.binding.storeId,
      workspaceId: context.binding.workspaceId,
      clientNamespace: context.binding.clientNamespace,
    },
    sessionId: SESSION_ID,
    ownerGeneration: "1",
    continuityKey: "executor-identity-test",
    state: "active",
    resumedFromSessionId: null,
    latestCheckpointEventPosition: null,
    eventPosition: "1",
    handleIssued: false,
    resumeTokenIssued: false,
    contextPackUnavailable: true,
  };
  return {
    operation: "root-start",
    nestedContractVersion: null,
    result: {
      kind: "success",
      publicResult,
      authorityMaterial: {
        status: "not-issued",
        target: null,
        authorityCommitment: null,
        capabilityGeneration: null,
        descriptor: null,
        recoveryCode: null,
      },
    },
  };
}

const BOUNDED_PROOF: CapabilityProofV1 = {
  proofVersion: 1,
  target: "bounded-operation",
  proofNonce: "00000000-0000-4000-8000-000000000030",
  proofFingerprint: HASH,
};

function boundedInput(): LifecycleBoundedMutationInput {
  return {
    operation: "renew-root-lease",
    operationId: OPERATION_ID,
    requestId: REQUEST_ID,
    authorization: {
      kind: "bounded-operation",
      authoritySessionId: SESSION_ID,
      targetSessionId: SESSION_ID,
      proof: BOUNDED_PROOF,
    },
    sessionId: SESSION_ID,
    expectedOwnerGeneration: 1,
  };
}

function queryInput(operation: LifecycleQueryInput["operation"] = "read-session-status"): LifecycleQueryInput {
  return {
    operation,
    operationId: OPERATION_ID,
    requestId: REQUEST_ID,
    authorization: boundedInput().authorization,
    sessionId: SESSION_ID,
  } as LifecycleQueryInput;
}

function internalPlan(context: ProjectContext): InternalWorkflowExecutionPlan {
  return {
    commandType: "internal-workflow-phase",
    commandId: "00000000-0000-4000-8000-000000000040",
    idempotencyKey: "internal-workflow-phase/executor-test",
    agentId: "trusted-coordinator",
    expectedProjectId: context.binding.projectId,
    expectedVaultId: context.binding.vaultId,
    expectedWorkspaceId: context.binding.workspaceId,
    expectedBranchRef: null,
    workflowId: WORKFLOW_ID,
    workflowGeneration: 1,
    sourcePhase: "validating",
    plannedWorkId: OTHER_HASH,
    claim: {
      workflowId: WORKFLOW_ID,
      workflowGeneration: 1,
      claimOwnerId: "00000000-0000-4000-8000-000000000050",
      claimToken: "7",
      claimExpiresAt: "2026-07-17T00:10:00.000Z",
    },
    plannedAction: {
      action: "record-verification-failed",
      validationResultIds: [OPERATION_ID as never],
      safeFailureCode: "SESSION_VALIDATION_RESULT_INVALID",
    },
  };
}

function workflowSelection(): LifecycleFencedInput {
  return {
    operation: "workflow-claim-next",
    workId: WORK_ID,
    ownerId: "coordinator-a",
    observedNowMs: String(Date.parse(NOW)),
    ttlMs: "60000",
  };
}

function outboxSelection(): LifecycleFencedInput {
  return {
    operation: "outbox-claim-next",
    workId: "outbox-selection-1",
    ownerId: "materializer-a",
    observedNowMs: String(Date.parse(NOW)),
    ttlMs: "60000",
  };
}

function workflowTarget(): LifecycleFencedInput {
  return {
    operation: "workflow-renew",
    workId: "workflow-renew-1",
    ownerId: "coordinator-a",
    fencingToken: "7",
    workflowId: WORKFLOW_ID,
    workflowGeneration: 3,
    leaseUntil: "2026-07-17T00:10:00.000Z",
  };
}

function outboxTarget(): LifecycleFencedInput {
  return {
    operation: "outbox-failure",
    workId: "outbox-failure-1",
    ownerId: "materializer-a",
    fencingToken: "9",
    targetKey: "memory/session.md",
    materializationRevision: "4",
    retryable: true,
    safeErrorCode: "STORE_UNAVAILABLE",
    attempt: 2,
    nextAttemptAt: null,
  };
}

function workflowRecovery(): LifecycleFencedInput {
  return {
    operation: "workflow-recovery",
    workId: "workflow-recovery-1",
    ownerId: "coordinator-a",
    fencingToken: "11",
    dueBefore: NOW,
    limit: 25,
  };
}

function lastLifecycle(worker: FakeWorker): Extract<WorkerRequest, { type: "lifecycle" }> {
  const request = worker.posted.at(-1);
  assert.equal(request?.type, "lifecycle");
  return request as Extract<WorkerRequest, { type: "lifecycle" }>;
}

function assertDeeplyFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeeplyFrozen(nested);
}

function exactError(code: string, details: Record<string, JsonValue>): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof ProjectStoreWorkerError);
    assert.equal(error.code, code);
    assert.deepEqual(error.details, details);
    assertDeeplyFrozen(error.details);
    return true;
  };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
}

// These calls are never executed. They make inference regressions fail every test build.
function exactResultCompileMatrix(executor: ProjectStoreExecutor): void {
  const authorization = {
    kind: "bounded-operation" as const,
    authoritySessionId: SESSION_ID,
    targetSessionId: SESSION_ID,
    proof: BOUNDED_PROOF,
  };
  const renew: Promise<RootLeaseRenewalResultV1> = executor.executeLifecycleBounded({
    operation: "renew-root-lease", operationId: OPERATION_ID, requestId: REQUEST_ID,
    authorization, sessionId: SESSION_ID, expectedOwnerGeneration: 1,
  });
  const tree: Promise<SessionTreeSummaryV1> = executor.queryLifecycle({
    operation: "read-session-tree", operationId: OPERATION_ID, requestId: REQUEST_ID,
    authorization, sessionId: SESSION_ID,
  });
  const status: Promise<SessionStatusSummaryV1> = executor.queryLifecycle({
    operation: "read-session-status", operationId: OPERATION_ID, requestId: REQUEST_ID,
    authorization, sessionId: SESSION_ID,
  });
  const association: Promise<SessionAssociationValidationV1> = executor.queryLifecycle({
    operation: "read-session-association", operationId: OPERATION_ID, requestId: REQUEST_ID,
    authorization, sessionId: SESSION_ID,
  });
  const workflowClaimNext: Promise<SessionEndWorkflowClaimWireV1 | null> = executor.executeLifecycleFenced({
    operation: "workflow-claim-next", workId: WORK_ID, ownerId: "owner", observedNowMs: "1", ttlMs: "1",
  });
  const workflowClaim: Promise<SessionEndWorkflowClaimWireV1 | null> = executor.executeLifecycleFenced({
    operation: "workflow-claim", workId: WORK_ID, ownerId: "owner", fencingToken: "1",
    workflowId: WORKFLOW_ID, workflowGeneration: 1, leaseUntil: NOW,
  });
  const workflowRenew: Promise<SessionEndWorkflowClaimWireV1> = executor.executeLifecycleFenced({
    operation: "workflow-renew", workId: WORK_ID, ownerId: "owner", fencingToken: "1",
    workflowId: WORKFLOW_ID, workflowGeneration: 1, leaseUntil: NOW,
  });
  const workflowRelease: Promise<boolean> = executor.executeLifecycleFenced({
    operation: "workflow-release", workId: WORK_ID, ownerId: "owner", fencingToken: "1",
    workflowId: WORKFLOW_ID, workflowGeneration: 1,
  });
  const workflowPhase: Promise<SessionEndPhaseResultV2> = executor.executeLifecycleFenced({
    operation: "workflow-eventless-phase", workId: WORK_ID, ownerId: "owner", fencingToken: "1",
    workflowId: WORKFLOW_ID, workflowGeneration: 1, expectedPhase: "requested", nextPhase: "children-resolved",
  });
  const workflowRecovery: Promise<LifecycleRecoveryScanResultWireV1> = executor.executeLifecycleFenced({
    operation: "workflow-recovery", workId: WORK_ID, ownerId: "owner", fencingToken: "1",
    dueBefore: NOW, limit: 10,
  });
  const outboxClaimNext: Promise<LifecycleOutboxClaimWireV1 | null> = executor.executeLifecycleFenced({
    operation: "outbox-claim-next", workId: WORK_ID, ownerId: "owner", observedNowMs: "1", ttlMs: "1",
  });
  const outboxClaim: Promise<LifecycleOutboxClaimWireV1 | null> = executor.executeLifecycleFenced({
    operation: "outbox-claim", workId: WORK_ID, ownerId: "owner", fencingToken: "1",
    targetKey: "memory/session.md", materializationRevision: "1", leaseUntil: NOW,
  });
  const outboxRenew: Promise<LifecycleOutboxClaimWireV1> = executor.executeLifecycleFenced({
    operation: "outbox-renew", workId: WORK_ID, ownerId: "owner", fencingToken: "1",
    targetKey: "memory/session.md", materializationRevision: "1", leaseUntil: NOW,
  });
  const materialize: Promise<MaterializationResultWireV1> = executor.executeLifecycleFenced({
    operation: "outbox-materialize", workId: WORK_ID, ownerId: "owner", fencingToken: "1",
    targetKey: "memory/session.md", materializationRevision: "1",
  });
  const outboxFailure: Promise<boolean> = executor.executeLifecycleFenced({
    operation: "outbox-failure", workId: WORK_ID, ownerId: "owner", fencingToken: "1",
    targetKey: "memory/session.md", materializationRevision: "1", retryable: false,
    safeErrorCode: "STORE_UNAVAILABLE", attempt: 1, nextAttemptAt: null,
  });

  // @ts-expect-error nullable claim cannot become a non-null renewal result.
  const inverseWorkflow: Promise<SessionEndWorkflowClaimWireV1> = workflowClaim;
  // @ts-expect-error a tree result is not a status result.
  const inverseQuery: Promise<SessionStatusSummaryV1> = tree;
  // @ts-expect-error a boolean release is not a phase result.
  const inverseOperational: Promise<SessionEndPhaseResultV2> = workflowRelease;
  // @ts-expect-error nullable outbox claim is not a materialization result.
  const inverseOutbox: Promise<MaterializationResultWireV1> = outboxClaimNext;
  void [
    renew, tree, status, association, workflowClaimNext, workflowClaim, workflowRenew,
    workflowRelease, workflowPhase, workflowRecovery, outboxClaimNext, outboxClaim,
    outboxRenew, materialize, outboxFailure, inverseWorkflow, inverseQuery,
    inverseOperational, inverseOutbox,
  ];
}

void exactResultCompileMatrix;

const invalidBoundedAlias = {
  ...boundedInput(),
  // @ts-expect-error ProjectContext is not part of a bounded worker input.
  context: {} as ProjectContext,
} satisfies LifecycleBoundedMutationInput;
const invalidBoundedAudienceAlias = {
  ...boundedInput(),
  authorization: {
    ...boundedInput().authorization,
    // @ts-expect-error The active worker derives the bounded audience.
    audience: {},
  },
} satisfies LifecycleBoundedMutationInput;
const invalidQueryAlias = {
  ...queryInput(),
  // @ts-expect-error ProjectContext is not part of a query worker input.
  context: {} as ProjectContext,
} satisfies LifecycleQueryInput;
const invalidQueryAudienceAlias = {
  ...queryInput(),
  authorization: {
    ...queryInput().authorization,
    // @ts-expect-error The active worker derives the query audience.
    audience: {},
  },
} satisfies LifecycleQueryInput;
const invalidFencedAlias = {
  ...workflowSelection(),
  // @ts-expect-error ProjectContext is not part of a fenced worker input.
  context: {} as ProjectContext,
} satisfies LifecycleFencedInput;

function negativeExecutorCompileSurface(
  executor: ProjectStoreExecutor,
  context: ProjectContext,
  prepared: PreparedLifecycleWorkerCommand<LifecycleSemanticCommandDraft>,
  adapter: AuthorityMaterialAdapter,
): void {
  // @ts-expect-error Raw semantic drafts are never accepted by the executor.
  executor.executeLifecycleMutation(rootStart(context));
  // @ts-expect-error Private bearer material is not a per-call executor argument.
  executor.executeLifecycleMutation(prepared, { kind: "protected", bearer: null });
  // @ts-expect-error Audience is worker-derived and is not a per-call argument.
  executor.executeLifecycleMutation(prepared, { presentingActorRole: "primary" });
  // @ts-expect-error The exact adapter is constructor-injected, never per-call.
  executor.executeLifecycleMutation(prepared, adapter);
  // @ts-expect-error Contextful bounded literals are rejected, not stripped.
  executor.executeLifecycleBounded({ ...boundedInput(), context });
  // @ts-expect-error Contextful query literals are rejected, not stripped.
  executor.queryLifecycle({ ...queryInput(), context });
  // @ts-expect-error Contextful fenced literals are rejected, not stripped.
  executor.executeLifecycleFenced({ ...workflowSelection(), context });
}

void [
  invalidBoundedAlias,
  invalidBoundedAudienceAlias,
  invalidQueryAlias,
  invalidQueryAudienceAlias,
  invalidFencedAlias,
  negativeExecutorCompileSurface,
];

describe("lifecycle executor", () => {
  it("preserves command identity after uncertain semantic delivery", async () => {
    const successful = await harness(true);
    const prepared = await prepareRoot(successful);
    const execution = successful.executor.executeLifecycleMutation(prepared);
    successful.worker.succeed(lastLifecycle(successful.worker), semanticSuccess(successful.context));
    const completed = await execution;
    assert.equal(
      typeof completed.publicResult === "object"
        && completed.publicResult !== null
        && !Array.isArray(completed.publicResult)
        ? completed.publicResult.sessionId
        : null,
      SESSION_ID,
    );
    assert.deepEqual(successful.adapter!.completionIdentities, [{
      projectId: successful.context.binding.projectId,
      commandId: prepared.command.commandId,
      idempotencyKey: prepared.command.idempotencyKey,
    }]);
    assertDeeplyFrozen(successful.adapter!.completionIdentities[0]);

    const definitive = await harness(true);
    const definitivePrepared = await prepareRoot(
      definitive,
      "00000000-0000-4000-8000-000000000036",
    );
    const definitivePending = definitive.executor.executeLifecycleMutation(definitivePrepared);
    definitive.worker.fail(
      lastLifecycle(definitive.worker),
      "LIFECYCLE_OPERATION_UNAVAILABLE",
    );
    await assert.rejects(definitivePending, (error) => (
      error instanceof LifecycleError && error.code === "LIFECYCLE_OPERATION_UNAVAILABLE"
    ));
    assert.deepEqual(definitive.adapter!.completionIdentities, [{
      projectId: definitive.context.binding.projectId,
      commandId: definitivePrepared.command.commandId,
      idempotencyKey: definitivePrepared.command.idempotencyKey,
    }]);
    assert.equal(await definitive.pending!.get(
      PROJECT_ID,
      definitivePrepared.command.commandId,
      definitivePrepared.command.idempotencyKey,
    ), null);
    assert.equal(definitive.worker.terminateCalls, 0);

    const inner = await harness(true);
    const innerPrepared = await prepareRoot(inner, "00000000-0000-4000-8000-000000000031");
    const innerPending = inner.executor.executeLifecycleMutation(innerPrepared);
    inner.worker.succeed(lastLifecycle(inner.worker), {
      operation: "root-start",
      nestedContractVersion: null,
      result: { kind: "unknown", errorCode: "COMMAND_OUTCOME_UNKNOWN" },
    });
    await assert.rejects(innerPending, exactError("COMMAND_OUTCOME_UNKNOWN", {
      commandId: innerPrepared.command.commandId,
      idempotencyKey: innerPrepared.command.idempotencyKey,
    }));
    await turn();
    assert.equal(inner.worker.terminateCalls, 1);
    assert.equal(inner.adapter!.completionIdentities.length, 1);
    assert.ok(await inner.pending!.get(PROJECT_ID, innerPrepared.command.commandId, innerPrepared.command.idempotencyKey));

    const innerProtocol = await harness(true);
    const innerProtocolPrepared = await prepareRoot(
      innerProtocol,
      "00000000-0000-4000-8000-000000000037",
    );
    const innerProtocolPending = innerProtocol.executor.executeLifecycleMutation(
      innerProtocolPrepared,
    );
    innerProtocol.worker.succeed(lastLifecycle(innerProtocol.worker), {
      operation: "root-start",
      nestedContractVersion: null,
      result: { kind: "rejected", errorCode: "WORKER_PROTOCOL_ERROR" },
    });
    await assert.rejects(innerProtocolPending, exactError("COMMAND_OUTCOME_UNKNOWN", {
      commandId: innerProtocolPrepared.command.commandId,
      idempotencyKey: innerProtocolPrepared.command.idempotencyKey,
    }));
    await turn();
    assert.equal(innerProtocol.worker.terminateCalls, 1);
    assert.deepEqual(innerProtocol.adapter!.completionIdentities, []);
    assert.ok(await innerProtocol.pending!.get(
      PROJECT_ID,
      innerProtocolPrepared.command.commandId,
      innerProtocolPrepared.command.idempotencyKey,
    ));

    const outer = await harness(true);
    const outerPrepared = await prepareRoot(outer, "00000000-0000-4000-8000-000000000032");
    const outerPending = outer.executor.executeLifecycleMutation(outerPrepared);
    outer.worker.fail(lastLifecycle(outer.worker), "COMMAND_OUTCOME_UNKNOWN", {
      commandId: "untrusted-command",
      idempotencyKey: "untrusted-key",
      projectId: "untrusted-project",
    });
    await assert.rejects(outerPending, exactError("COMMAND_OUTCOME_UNKNOWN", {
      commandId: outerPrepared.command.commandId,
      idempotencyKey: outerPrepared.command.idempotencyKey,
    }));
    await turn();
    assert.equal(outer.worker.terminateCalls, 1);
    assert.equal(outer.adapter!.completionIdentities.length, 0);

    const timed = await harness(true);
    const timedPrepared = await prepareRoot(timed, "00000000-0000-4000-8000-000000000033");
    const timedPending = timed.executor.executeLifecycleMutation(timedPrepared);
    timed.scheduler.runNext();
    await assert.rejects(timedPending, exactError("COMMAND_OUTCOME_UNKNOWN", {
      commandId: timedPrepared.command.commandId,
      idempotencyKey: timedPrepared.command.idempotencyKey,
    }));
    await turn();
    const postsAfterPoison = timed.worker.posted.length;
    assert.throws(() => timed.executor.quickIntegrity(), (error) => (
      error instanceof ProjectStoreWorkerError && error.code === "WORKER_TIMEOUT"
    ));
    assert.equal(timed.worker.posted.length, postsAfterPoison);
  });

  it("preserves bounded identity after uncertain lifecycle delivery", async () => {
    const cases: ReadonlyArray<readonly [
      fail: (h: Harness, request: WorkerRequest) => void,
      expectedTerminateCalls: number,
    ]> = [
      [(h, _request) => h.worker.emit("exit", 9), 0],
      [(h, request) => h.worker.emit("error", new Error(`lost ${request.id}`)), 1],
      [(h, _request) => h.worker.emit("messageerror", new Error("clone failed")), 1],
      [(h, request) => h.worker.emit("message", { id: request.id, ok: true, data: { malformed: true } }), 1],
      [(h, request) => h.worker.succeed(request, {
        operation: "renew-root-lease",
        nestedContractVersion: 1,
        result: {},
      }), 1],
      [(h, request) => h.worker.succeed(request, {
        operation: "renew-root-lease",
        nestedContractVersion: null,
        result: {
          resultVersion: 1,
          operationId: "00000000-0000-4000-8000-000000000099",
          requestId: REQUEST_ID,
          sessionId: SESSION_ID,
          ownerGeneration: "1",
          lastObservedAt: NOW,
          expiresAt: "2026-07-17T00:10:00.000Z",
        },
      }), 1],
      [(h, request) => h.worker.fail(request, "OPERATION_OUTCOME_UNKNOWN", {
        operationId: "untrusted-operation",
        requestId: "untrusted-request",
      }), 1],
    ];
    for (const [fail, expectedTerminateCalls] of cases) {
      const h = await harness();
      const pending = h.executor.executeLifecycleBounded(boundedInput());
      const request = lastLifecycle(h.worker);
      fail(h, request);
      await assert.rejects(pending, exactError("OPERATION_OUTCOME_UNKNOWN", {
        operationId: OPERATION_ID,
        requestId: REQUEST_ID,
      }));
      await turn();
      assert.equal(h.worker.terminateCalls, expectedTerminateCalls);
    }

    const synchronous = await harness();
    synchronous.worker.throwOnPost = true;
    await assert.rejects(
      synchronous.executor.executeLifecycleBounded(boundedInput()),
      (error) => error instanceof ProjectStoreWorkerError && error.code === "WORKER_UNAVAILABLE",
    );
    await turn();
    assert.equal(synchronous.worker.posted.filter((request) => request.type === "lifecycle").length, 0);
  });

  it("preserves fenced selection identity after uncertain lifecycle delivery", async () => {
    const cases: ReadonlyArray<readonly [LifecycleFencedInput, Record<string, JsonValue>]> = [
      [workflowSelection(), {
        kind: "workflow-selection", projectId: PROJECT_ID, workId: WORK_ID,
        operation: "claim-next", ownerId: "coordinator-a",
      }],
      [outboxSelection(), {
        kind: "outbox-selection", projectId: PROJECT_ID, workId: "outbox-selection-1",
        operation: "claim-next", ownerId: "materializer-a",
      }],
      [workflowTarget(), {
        kind: "workflow", projectId: PROJECT_ID, workflowId: WORKFLOW_ID,
        workflowGeneration: "3", operation: "renew", ownerId: "coordinator-a", claimToken: "7",
      }],
      [outboxTarget(), {
        kind: "outbox", projectId: PROJECT_ID, targetKey: "memory/session.md",
        materializationRevision: "4", operation: "record-failure", ownerId: "materializer-a", claimToken: "9",
      }],
      [workflowRecovery(), {
        projectId: PROJECT_ID, workId: "workflow-recovery-1", operation: "workflow-recovery",
        ownerId: "coordinator-a", fencingToken: "11",
      }],
    ];
    for (const [input, work] of cases) {
      const h = await harness();
      const pending = h.executor.executeLifecycleFenced(input);
      const request = lastLifecycle(h.worker);
      h.worker.fail(request, "OPERATION_OUTCOME_UNKNOWN", {
        work: { kind: "invented", workflowId: "invented", targetKey: "invented" },
      });
      await assert.rejects(pending, exactError("OPERATION_OUTCOME_UNKNOWN", { work }));
      await turn();
      assert.equal(h.worker.terminateCalls, 1);
    }

    const mismatchedSuccesses: ReadonlyArray<readonly [
      LifecycleFencedInput,
      Record<string, JsonValue>,
      Record<string, JsonValue>,
    ]> = [
      [workflowSelection(), {
        resultVersion: 1,
        projectId: "00000000-0000-4000-8000-000000000099",
        workflowId: WORKFLOW_ID,
        sessionId: SESSION_ID,
        workflowGeneration: 3,
        phase: "requested",
        ownerId: "coordinator-a",
        claimToken: "7",
        claimExpiresAt: "2026-07-17T00:10:00.000Z",
        triggeringEventPosition: "1",
        attemptCount: 0,
      }, {
        kind: "workflow-selection", projectId: PROJECT_ID, workId: WORK_ID,
        operation: "claim-next", ownerId: "coordinator-a",
      }],
      [workflowTarget(), {
        resultVersion: 1,
        projectId: PROJECT_ID,
        workflowId: "00000000-0000-4000-8000-000000000099",
        sessionId: SESSION_ID,
        workflowGeneration: 3,
        phase: "requested",
        ownerId: "coordinator-a",
        claimToken: "7",
        claimExpiresAt: "2026-07-17T00:10:00.000Z",
        triggeringEventPosition: "1",
        attemptCount: 0,
      }, {
        kind: "workflow", projectId: PROJECT_ID, workflowId: WORKFLOW_ID,
        workflowGeneration: "3", operation: "renew", ownerId: "coordinator-a", claimToken: "7",
      }],
    ];
    for (const [input, result, work] of mismatchedSuccesses) {
      const h = await harness();
      const pending = h.executor.executeLifecycleFenced(input);
      const request = lastLifecycle(h.worker);
      h.worker.succeed(request, {
        operation: input.operation,
        nestedContractVersion: null,
        result,
      });
      await assert.rejects(pending, exactError("OPERATION_OUTCOME_UNKNOWN", { work }));
      await turn();
      assert.equal(h.worker.terminateCalls, 1);
    }
  });

  it("routes read operations only through queryLifecycle", async () => {
    const h = await harness();
    const pending = h.executor.queryLifecycle(queryInput("read-session-association"));
    const request = lastLifecycle(h.worker);
    assert.equal(request.operation.kind, "query");
    assert.equal(request.operation.operation, "read-session-association");
    h.worker.succeed(request, {
      operation: "read-session-association",
      nestedContractVersion: null,
      result: {
        resultVersion: 1,
        operation: "read-session-association",
        operationId: OPERATION_ID,
        requestId: REQUEST_ID,
        associated: true,
        sessionId: SESSION_ID,
        rootSessionId: SESSION_ID,
      },
    });
    const result = await pending;
    if (result.operation !== "read-session-association") assert.fail("query result tag changed");
    assert.equal(result.associated, true);

    const mismatched = await harness();
    const mismatchedPending = mismatched.executor.queryLifecycle(
      queryInput("read-session-association"),
    );
    const mismatchedRequest = lastLifecycle(mismatched.worker);
    mismatched.worker.succeed(mismatchedRequest, {
      operation: "read-session-association",
      nestedContractVersion: null,
      result: {
        resultVersion: 1,
        operation: "read-session-association",
        operationId: OPERATION_ID,
        requestId: REQUEST_ID,
        associated: true,
        sessionId: "00000000-0000-4000-8000-000000000099",
        rootSessionId: SESSION_ID,
      },
    });
    await assert.rejects(mismatchedPending, (error) => (
      error instanceof ProjectStoreWorkerError
      && error.code === "WORKER_PROTOCOL_ERROR"
      && Object.keys(error.details).length === 0
    ));
    await turn();
    assert.equal(mismatched.worker.terminateCalls, 1);

    const uncertainRead = h.executor.queryLifecycle(queryInput("read-session-status"));
    const uncertainRequest = lastLifecycle(h.worker);
    h.worker.emit("error", new Error("read transport lost"));
    await assert.rejects(uncertainRead, (error) => (
      error instanceof ProjectStoreWorkerError && error.code === "WORKER_UNAVAILABLE"
    ));
    assert.equal(uncertainRequest.operation.kind, "query");

    for (const code of ["COMMAND_OUTCOME_UNKNOWN", "OPERATION_OUTCOME_UNKNOWN"] as const) {
      const reportedUnknown = await harness();
      const reportedPending = reportedUnknown.executor.queryLifecycle(
        queryInput("read-session-status"),
      );
      const reportedRequest = lastLifecycle(reportedUnknown.worker);
      reportedUnknown.worker.fail(reportedRequest, code, {
        commandId: "untrusted-command",
        operationId: "untrusted-operation",
        requestId: "untrusted-request",
        canary: "must-not-escape",
      });
      await assert.rejects(reportedPending, (error) => {
        assert.ok(error instanceof ProjectStoreWorkerError);
        assert.equal(error.code, "WORKER_PROTOCOL_ERROR");
        assert.deepEqual(error.details, {});
        return true;
      });
      await turn();
      assert.equal(reportedUnknown.worker.terminateCalls, 1);
      assert.equal(
        reportedUnknown.worker.posted.filter((posted) => posted.type === "lifecycle").length,
        1,
      );
    }
  });

  it("rejects caller project context at the executor boundary", async () => {
    const h = await harness(true);
    const prepared = await prepareRoot(h, "00000000-0000-4000-8000-000000000034");
    const baseline = h.worker.posted.length;
    const malformed: unknown[] = [
      [{ ...boundedInput(), context: h.context }, "bounded"],
      [{ ...boundedInput(), authorization: { ...boundedInput().authorization, audience: {} } }, "bounded"],
      [{ ...queryInput(), context: h.context }, "query"],
      [{ ...queryInput(), authorization: { ...queryInput().authorization, audience: {} } }, "query"],
      [{ ...workflowSelection(), context: h.context }, "fenced"],
      [{ ...prepared, context: h.context }, "semantic"],
      [{ ...internalPlan(h.context), context: h.context }, "internal"],
    ];
    for (const [value, route] of malformed as Array<[unknown, string]>) {
      assert.throws(() => {
        if (route === "bounded") h.executor.executeLifecycleBounded(value as LifecycleBoundedMutationInput);
        else if (route === "query") h.executor.queryLifecycle(value as LifecycleQueryInput);
        else if (route === "fenced") h.executor.executeLifecycleFenced(value as LifecycleFencedInput);
        else if (route === "semantic") {
          h.executor.executeLifecycleMutation(value as PreparedLifecycleWorkerCommand<LifecycleSemanticCommandDraft>);
        } else h.executor.executeLifecycleInternalMutation(value as InternalWorkflowExecutionPlan);
      }, (error) => error instanceof LifecycleError && error.code === "WORKER_PROTOCOL_ERROR");
      assert.equal(h.worker.posted.length, baseline);
    }
  });

  it("adapter absence disables only external lifecycle mutation", async () => {
    const h = await harness();
    const authority = adapterFixture(h.root, h.context);
    const prepared = await authority.adapter.prepare(
      rootStart(h.context, "00000000-0000-4000-8000-000000000035"),
      { kind: "initial-authority" },
      trustedContext(h.context),
    );
    const baseline = h.worker.posted.length;
    assert.throws(
      () => h.executor.executeLifecycleMutation(prepared),
      (error) => error instanceof ProjectStoreWorkerError && error.code === "LIFECYCLE_V2_DISABLED",
    );
    assert.equal(h.worker.posted.length, baseline);
    assert.ok(await authority.pending.get(PROJECT_ID, prepared.command.commandId, prepared.command.idempotencyKey));

    const availableCalls = [
      h.executor.executeLifecycleInternalMutation(internalPlan(h.context)),
      h.executor.executeLifecycleBounded(boundedInput()),
      h.executor.queryLifecycle(queryInput()),
      h.executor.executeLifecycleFenced(workflowSelection()),
    ];
    const lifecycleRequests = h.worker.posted.slice(baseline) as Array<Extract<WorkerRequest, { type: "lifecycle" }>>;
    assert.deepEqual(lifecycleRequests.map((request) => request.operation.kind), [
      "internal-semantic", "bounded", "query", "fenced",
    ]);
    for (const request of lifecycleRequests) {
      assert.equal(JSON.stringify(request).includes("authorityMaterialAdapter"), false);
      h.worker.fail(request, "LIFECYCLE_OPERATION_UNAVAILABLE");
    }
    for (const call of availableCalls) {
      await assert.rejects(call, (error) => (
        error instanceof ProjectStoreWorkerError && error.code === "LIFECYCLE_OPERATION_UNAVAILABLE"
      ));
    }
  });
});
