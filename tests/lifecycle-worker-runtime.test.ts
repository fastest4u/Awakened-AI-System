import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import {
  createCapabilityProof,
  type SemanticCommandProofTargetV1,
} from "../src/orchestrator/lifecycle/authority/capability-codec.js";
import type { WorkerLifecycleResult } from "../src/orchestrator/lifecycle/authority/authority-material-adapter.js";
import {
  CapabilityService,
  type RootOrChildAuthorityMaterial,
} from "../src/orchestrator/lifecycle/capability.service.js";
import { CheckpointService } from "../src/orchestrator/lifecycle/checkpoint.service.js";
import type {
  PreparedLifecycleWorkerCommand,
  RecordCheckpointCommandV2,
  RecordCheckpointCommandV3,
  RecordEvidenceBatchCommandV2,
  RootStartCommandV2,
} from "../src/orchestrator/lifecycle/contracts/commands.js";
import { EvidenceCoverageService } from "../src/orchestrator/lifecycle/evidence-coverage.service.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import {
  connectionBoundEvidenceCoverage,
  type LifecycleCommandTransaction,
} from "../src/orchestrator/lifecycle/lifecycle-command.store.js";
import { buildLifecycleIntentWitness } from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import { ChildTransferRepository } from "../src/orchestrator/storage/child-transfer.repository.js";
import { EvidenceCoverageRepository } from "../src/orchestrator/storage/evidence-coverage.repository.js";
import { LifecycleApprovalRepository } from "../src/orchestrator/storage/lifecycle-approval.repository.js";
import type { SessionAuthorityRecord } from "../src/orchestrator/storage/lifecycle-storage.types.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { SessionAuthorityRepository } from "../src/orchestrator/storage/session-authority.repository.js";
import { SessionLeaseRepository } from "../src/orchestrator/storage/session-lease.repository.js";
import type { SqliteConnection } from "../src/orchestrator/storage/sqlite-driver.js";
import {
  SqliteLifecycleProjectionRepository,
  type LifecycleProjectionWriter,
} from "../src/orchestrator/storage/lifecycle-projection.repository.js";
import {
  ConnectionBoundLifecycleWorkerRuntime,
  type ConnectionBoundLifecycleWorkerRuntimeOptions,
  type LifecycleWorkerRuntime,
  type PreparedCheckpointLifecycleHandler,
  type PreparedEvidenceLifecycleHandler,
} from "../src/orchestrator/runtime/lifecycle-worker-runtime.js";
import {
  LifecycleWorkerRuntimeFactory,
  type LifecycleRuntimeClock,
  type LifecycleRuntimeIdentitySource,
  type LifecycleRuntimeRepositoryFactories,
  type LifecycleTransactionFacadeFactory,
  type LifecycleWorkerRuntimeCreateInput,
  type LifecycleWorkerRuntimeFactoryOptions,
  type LifecycleWorkerRuntimeFactoryPort,
} from "../src/orchestrator/runtime/lifecycle-worker-runtime.factory.js";
import type { LifecycleWorkerOperationWire } from "../src/orchestrator/runtime/lifecycle-worker-protocol.js";
import { DeterministicCapabilityKeyProvider } from "./support/lifecycle-authority-reference.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";
import {
  PROJECT_ID,
  STORE_ID,
  VAULT_ID,
  WORKSPACE_ID,
  checkpointFixture,
  lifecycleUuid,
  qualifiedCheckpointFixture,
} from "./support/lifecycle-fixtures.js";

void ConnectionBoundLifecycleWorkerRuntime;
void LifecycleWorkerRuntimeFactory;

type RequiredRuntimeSurface = readonly [
  ConnectionBoundLifecycleWorkerRuntimeOptions,
  LifecycleWorkerRuntime,
  PreparedCheckpointLifecycleHandler,
  PreparedEvidenceLifecycleHandler,
  LifecycleRuntimeClock,
  LifecycleRuntimeIdentitySource,
  LifecycleRuntimeRepositoryFactories,
  LifecycleTransactionFacadeFactory,
  LifecycleWorkerRuntimeCreateInput,
  LifecycleWorkerRuntimeFactoryOptions,
  LifecycleWorkerRuntimeFactoryPort,
];

void (undefined as unknown as RequiredRuntimeSurface);

const PROJECT_CONTEXT = Object.freeze({
  workspace: Object.freeze({ kind: "git", head: "a".repeat(40), branch: "main", dirty: false }),
  checkedAt: "2026-07-14T00:00:00.000Z",
  binding: Object.freeze({
    projectId: "11111111-1111-4111-8111-111111111111",
    vaultId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "workspace-a",
    clientNamespace: "client-a",
    actorRole: "primary" as const,
    clientInstanceId: "instance-a",
    projectRoot: "C:\\project",
    vaultRoot: "C:\\project\\memory",
    descriptorPath: "C:\\project\\memory\\project.md",
    workspace: Object.freeze({ kind: "git", head: "a".repeat(40), branch: "main", dirty: false }),
    establishedAt: "2026-07-14T00:00:00.000Z",
    storeRoute: Object.freeze({
      storeId: "33333333-3333-4333-8333-333333333333",
      eventsPath: "C:\\project\\memory\\events.sqlite",
      blobsPath: "C:\\project\\memory\\blobs",
    }),
  }),
}) as unknown as ProjectContext;

const NOW = "2026-08-02T00:00:00.000Z";
const NOW_MS = BigInt(Date.parse(NOW));

class RuntimeIdentitySource {
  #next = 200_000;
  uuidCalls = 0;
  bytesCalls = 0;
  uuid(): string { this.uuidCalls += 1; return lifecycleUuid(this.#next++); }
  bytes(length: number): Uint8Array {
    this.bytesCalls += 1;
    return Buffer.alloc(length, this.#next++ % 251);
  }
}

class ReceiverClock implements LifecycleRuntimeClock {
  current = NOW;
  nowMsCalls = 0;
  nowCalls = 0;
  nowMs(): bigint { this.nowMsCalls += 1; return BigInt(Date.parse(this.current)); }
  now(): string { this.nowCalls += 1; return this.current; }
}

class RecordingMaintenanceFence extends MaintenanceFence {
  appendChecks = 0;
  readonly observedConnections: SqliteConnection[] = [];
  constructor(readonly expectedConnection: SqliteConnection) { super(); }
  override assertAppendAllowed(connection: SqliteConnection): void {
    this.appendChecks += 1;
    this.observedConnections.push(connection);
    assert.equal(connection, this.expectedConnection);
    super.assertAppendAllowed(connection);
  }
}

function runtimeContext(): ProjectContext {
  const workspace = Object.freeze({
    kind: "non-git" as const,
    workspaceRoot: "C:\\runtime-project",
    workspaceId: WORKSPACE_ID,
  });
  return Object.freeze({
    binding: Object.freeze({
      projectBindingId: "runtime-binding",
      generation: 1,
      contextFingerprint: createHash("sha256").update("runtime-binding").digest("hex"),
      source: "explicit-cli",
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "runtime/tests",
      clientInstanceId: "runtime-primary",
      actorRole: "primary" as const,
      projectRoot: "C:\\runtime-project",
      vaultRoot: "C:\\runtime-project\\memory",
      descriptorPath: "C:\\runtime-project\\memory\\.project-memory.json",
      storeRoute: Object.freeze({
        kind: "vault-local" as const,
        storeRoot: "C:\\runtime-project\\memory\\.memory-mcp",
        eventsPath: "C:\\runtime-project\\memory\\.memory-mcp\\events.sqlite",
        storeManifestPath: "C:\\runtime-project\\memory\\.memory-mcp\\store.json",
        projectionManifestPath: "C:\\runtime-project\\memory\\.memory-mcp\\projection.json",
      }),
      workspace,
      establishedAt: NOW,
    }),
    workspace,
    checkedAt: NOW,
  }) as ProjectContext;
}

function mismatchedActiveContexts(context: ProjectContext): readonly {
  readonly label: string;
  readonly context: ProjectContext;
  readonly code: "PROJECT_BINDING_REQUIRED" | "WORKSPACE_AMBIGUOUS";
}[] {
  const withBinding = (
    bindingPatch: Readonly<Record<string, unknown>>,
    workspace = context.workspace,
  ): ProjectContext => Object.freeze({
    ...context,
    binding: Object.freeze({ ...context.binding, ...bindingPatch, workspace }),
    workspace,
  }) as ProjectContext;
  const otherWorkspace = Object.freeze({
    kind: "non-git" as const,
    workspaceRoot: "C:\\wrong-runtime-project",
    workspaceId: "2".repeat(64) as ProjectContext["binding"]["workspaceId"],
  });
  const gitWorkspace = Object.freeze({
    kind: "git" as const,
    worktreeRoot: "C:\\runtime-project",
    gitDir: "C:\\runtime-project\\.git",
    gitCommonDir: "C:\\runtime-project\\.git",
    headCommit: "a".repeat(40),
    branchRef: "refs/heads/wrong",
    detached: false,
    workspaceId: context.binding.workspaceId,
  });
  return Object.freeze([
    {
      label: "project",
      context: withBinding({ projectId: lifecycleUuid(290_001) }),
      code: "PROJECT_BINDING_REQUIRED" as const,
    },
    {
      label: "vault",
      context: withBinding({ vaultId: lifecycleUuid(290_002) }),
      code: "PROJECT_BINDING_REQUIRED" as const,
    },
    {
      label: "workspace",
      context: withBinding({ workspaceId: otherWorkspace.workspaceId }, otherWorkspace),
      code: "PROJECT_BINDING_REQUIRED" as const,
    },
    {
      label: "branch",
      context: withBinding({}, gitWorkspace),
      code: "WORKSPACE_AMBIGUOUS" as const,
    },
  ]);
}

interface RuntimeCounters {
  readonly repositories: Record<"authority" | "leases" | "approvals" | "transfers" | "coverage" | "projection", number>;
  commandFacades: number;
  operationalFacades: number;
  projectionAppends: number;
  sourceStateScopes: number;
  sourceStateCaptures: number;
  authorityFolds: number;
  coveragePrepareBatches: number;
  integrityChecks: number;
  resumeSourceCaptures: number;
  genericSourceStateCaptures: number;
  finalizationSourceStateCaptures: number;
  childBindingFingerprints: number;
  workflowEffects: number;
  outboxEffects: number;
  filesystemEffects: number;
  driverOpens: number;
  readonly repositoryMethodCalls: string[];
  readonly commandFacadeInputs: unknown[];
  readonly operationalFacadeInputs: unknown[];
  readonly coverageProviders: unknown[];
  readonly projectionConnections: unknown[];
}

interface RuntimeFixture {
  readonly connection: SqliteConnection;
  readonly context: ProjectContext;
  readonly provider: DeterministicCapabilityKeyProvider;
  readonly clock: ReceiverClock;
  readonly ids: RuntimeIdentitySource;
  readonly counters: RuntimeCounters;
  readonly factory: LifecycleWorkerRuntimeFactory;
  readonly runtime: LifecycleWorkerRuntime;
  readonly authority: SessionAuthorityRepository;
  readonly leases: SessionLeaseRepository;
  readonly approvals: LifecycleApprovalRepository;
  readonly transfers: ChildTransferRepository;
  readonly coverage: EvidenceCoverageRepository;
  readonly projectionWriter: LifecycleProjectionWriter;
  readonly maintenanceFence: RecordingMaintenanceFence;
  readonly transactionFacades: LifecycleTransactionFacadeFactory;
  readonly cleanupRoot: string;
}

interface ServiceRecordSpy<TService> {
  calls: number;
  instance: TService | null;
  transaction: LifecycleCommandTransaction | null;
  restore(): void;
}

function spyCheckpointRecords(): ServiceRecordSpy<CheckpointService> {
  const original = CheckpointService.prototype.record;
  const spy: ServiceRecordSpy<CheckpointService> = {
    calls: 0,
    instance: null,
    transaction: null,
    restore: () => { CheckpointService.prototype.record = original; },
  };
  CheckpointService.prototype.record = function(
    this: CheckpointService,
    transaction: Parameters<CheckpointService["record"]>[0],
    command: Parameters<CheckpointService["record"]>[1],
  ): ReturnType<CheckpointService["record"]> {
    spy.calls += 1;
    spy.instance = this;
    spy.transaction = transaction;
    return original.call(this, transaction, command);
  };
  return spy;
}

function spyEvidenceRecords(): ServiceRecordSpy<EvidenceCoverageService> {
  const original = EvidenceCoverageService.prototype.record;
  const spy: ServiceRecordSpy<EvidenceCoverageService> = {
    calls: 0,
    instance: null,
    transaction: null,
    restore: () => { EvidenceCoverageService.prototype.record = original; },
  };
  EvidenceCoverageService.prototype.record = function(
    this: EvidenceCoverageService,
    transaction: Parameters<EvidenceCoverageService["record"]>[0],
    command: Parameters<EvidenceCoverageService["record"]>[1],
  ): ReturnType<EvidenceCoverageService["record"]> {
    spy.calls += 1;
    spy.instance = this;
    spy.transaction = transaction;
    return original.call(this, transaction, command);
  };
  return spy;
}

function commandTransaction(
  connection: SqliteConnection,
  authority: SessionAuthorityRepository,
  leases: SessionLeaseRepository,
  approvals: LifecycleApprovalRepository,
  transfers: ChildTransferRepository,
  coverage: EvidenceCoverageRepository,
  counters: RuntimeCounters,
): LifecycleCommandTransaction {
  const extendedAuthority = authority as SessionAuthorityRepository & {
    nextGlobalPosition(current: SqliteConnection): bigint;
    loadEvents(current: SqliteConnection, record: SessionAuthorityRecord): readonly unknown[];
  };
  return {
    authority: {
      get: (projectId: string, sessionId: string) => authority.get(connection, projectId, sessionId),
      insertRoot: (input: Parameters<SessionAuthorityRepository["insertRoot"]>[1]) => authority.insertRoot(connection, input),
      insertChild: (input: Parameters<SessionAuthorityRepository["insertChild"]>[1]) => authority.insertChild(connection, input),
      compareAndSwap: (input: Parameters<SessionAuthorityRepository["compareAndSwap"]>[1]) => authority.compareAndSwap(connection, input),
      listSafeResumeCandidates: (input: Parameters<SessionAuthorityRepository["listSafeResumeCandidates"]>[1]) => authority.listSafeResumeCandidates(connection, input),
      listNonterminalRootContinuityOwners: (input: Parameters<SessionAuthorityRepository["listNonterminalRootContinuityOwners"]>[1]) => authority.listNonterminalRootContinuityOwners(connection, input),
      listNonterminalChildren: (projectId: string, rootSessionId: string) => authority.listNonterminalChildren(connection, projectId, rootSessionId),
      listNonterminalChildEndingScopeProjectionsBounded: (projectId: string, rootSessionId: string, limit: number) => authority.listNonterminalChildEndingScopeProjectionsBounded(connection, projectId, rootSessionId, limit),
      latestCheckpoint: (record: SessionAuthorityRecord) => authority.latestCheckpoint(connection, record),
      rootContinuityKey: (record: SessionAuthorityRecord) => authority.rootContinuityKey(connection, record),
      nextGlobalPosition: () => extendedAuthority.nextGlobalPosition(connection),
      loadEvents: (record: SessionAuthorityRecord) => extendedAuthority.loadEvents(connection, record),
      requireFoldMatch: (record: SessionAuthorityRecord) => {
        counters.authorityFolds += 1;
        return authority.requireFoldMatch(connection, record);
      },
      markCheckpointRequired: (input: Parameters<SessionAuthorityRepository["markCheckpointRequired"]>[1]) => authority.markCheckpointRequired(connection, input),
      updateCheckpointIndex: (input: Parameters<SessionAuthorityRepository["updateCheckpointIndex"]>[1]) => authority.updateCheckpointIndex(connection, input),
      clearCheckpointRequired: (input: Parameters<SessionAuthorityRepository["clearCheckpointRequired"]>[1]) => authority.clearCheckpointRequired(connection, input),
    },
    leases: {
      current: (projectId: string, sessionId: string) => leases.current(connection, projectId, sessionId),
      isExpired: (lease: Parameters<SessionLeaseRepository["isExpired"]>[0], now: bigint) => leases.isExpired(lease, now),
      insertGeneration: (input: Parameters<SessionLeaseRepository["insertGeneration"]>[1]) => leases.insertGeneration(connection, input),
      renewCurrent: (input: Parameters<SessionLeaseRepository["renewCurrent"]>[1]) => leases.renewCurrent(connection, input),
      releaseCurrent: (input: Parameters<SessionLeaseRepository["releaseCurrent"]>[1]) => leases.releaseCurrent(connection, input),
    },
    approvals: {
      consume: (input: Parameters<LifecycleApprovalRepository["consume"]>[1]) => approvals.consume(connection, input),
    },
    transfers: {
      get: (projectId: string, ticketId: string) => transfers.get(connection, projectId, ticketId),
      findCreatedEventPosition: (projectId: string, ticketId: string) => transfers.findCreatedEventPosition(connection, projectId, ticketId),
      listUnclaimedEndingScopeProjectionsBySourceRoot: (projectId: string, sourceRootSessionId: string, limit: number) => transfers.listUnclaimedEndingScopeProjectionsBySourceRoot(connection, projectId, sourceRootSessionId, limit),
      insert: (input: Parameters<ChildTransferRepository["insert"]>[1]) => transfers.insert(connection, input),
      claim: (input: Parameters<ChildTransferRepository["claim"]>[1]) => transfers.claim(connection, input),
    },
    coverage: connectionBoundEvidenceCoverage(connection, coverage),
    workflows: {},
    validation: {},
    outbox: {},
  } as unknown as LifecycleCommandTransaction;
}

function observedRepository<T extends object>(
  name: string,
  target: T,
  counters: RuntimeCounters,
): T {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    get: (current, property) => {
      const value = Reflect.get(current, property, current) as unknown;
      if (typeof value !== "function") return value;
      const prior = methods.get(property);
      if (prior !== undefined) return prior;
      const wrapped = (...arguments_: unknown[]) => {
        counters.repositoryMethodCalls.push(`${name}.${String(property)}`);
        return Reflect.apply(value, current, arguments_) as unknown;
      };
      methods.set(property, wrapped);
      return wrapped;
    },
  });
}

function runtimeFixture(): RuntimeFixture {
  const counters: RuntimeCounters = {
    repositories: { authority: 0, leases: 0, approvals: 0, transfers: 0, coverage: 0, projection: 0 },
    commandFacades: 0,
    operationalFacades: 0,
    projectionAppends: 0,
    sourceStateScopes: 0,
    sourceStateCaptures: 0,
    authorityFolds: 0,
    coveragePrepareBatches: 0,
    integrityChecks: 0,
    resumeSourceCaptures: 0,
    genericSourceStateCaptures: 0,
    finalizationSourceStateCaptures: 0,
    childBindingFingerprints: 0,
    workflowEffects: 0,
    outboxEffects: 0,
    filesystemEffects: 0,
    driverOpens: 0,
    repositoryMethodCalls: [],
    commandFacadeInputs: [],
    operationalFacadeInputs: [],
    coverageProviders: [],
    projectionConnections: [],
  };
  const driver = new NodeSqliteDriver({ DatabaseSync });
  counters.driverOpens += 1;
  const cleanupRoot = mkdtempSync(join(tmpdir(), "lifecycle-worker-runtime-"));
  const connection = driver.open(join(cleanupRoot, "events.sqlite"), {
    mode: "create",
    busyTimeoutMs: 1_000,
  });
  applyCurrentProjectStoreSchema(connection, { projectId: PROJECT_ID, vaultId: VAULT_ID, storeId: STORE_ID }, NOW);
  const context = runtimeContext();
  const provider = new DeterministicCapabilityKeyProvider();
  const clock = new ReceiverClock();
  const ids = new RuntimeIdentitySource();
  const authority = observedRepository(
    "authority",
    new SessionAuthorityRepository(),
    counters,
  );
  const leases = observedRepository("leases", new SessionLeaseRepository(), counters);
  const approvals = observedRepository(
    "approvals",
    new LifecycleApprovalRepository(),
    counters,
  );
  const transfers = observedRepository("transfers", new ChildTransferRepository(), counters);
  let coverage: EvidenceCoverageRepository | null = null;
  let projectionWriter: LifecycleProjectionWriter | null = null;
  const repositories: LifecycleRuntimeRepositoryFactories = {
    authority: () => { counters.repositories.authority += 1; return authority; },
    leases: () => { counters.repositories.leases += 1; return leases; },
    approvals: () => { counters.repositories.approvals += 1; return approvals; },
    transfers: () => { counters.repositories.transfers += 1; return transfers; },
    coverage: (observedProvider) => {
      counters.repositories.coverage += 1;
      counters.coverageProviders.push(observedProvider);
      const repository = new EvidenceCoverageRepository(observedProvider);
      const prepareBatch = repository.prepareBatch.bind(repository);
      repository.prepareBatch = (...arguments_) => {
        counters.coveragePrepareBatches += 1;
        return prepareBatch(...arguments_);
      };
      coverage = observedRepository("coverage", repository, counters);
      return coverage;
    },
    projection: (observedConnection) => {
      counters.repositories.projection += 1;
      counters.projectionConnections.push(observedConnection);
      const projection = new SqliteLifecycleProjectionRepository(observedConnection);
      projectionWriter = Object.freeze({
        append: (...args: Parameters<LifecycleProjectionWriter["append"]>) => {
          counters.projectionAppends += 1;
          projection.append(...args);
        },
      });
      return projectionWriter;
    },
  };
  const transactionFacades: LifecycleTransactionFacadeFactory = {
    command: (input) => {
      counters.commandFacades += 1;
      counters.commandFacadeInputs.push(input);
      return commandTransaction(
        input.connection,
        input.authority,
        input.leases,
        input.approvals,
        input.transfers,
        input.coverage,
        counters,
      );
    },
    operational: (input) => {
      counters.operationalFacades += 1;
      counters.operationalFacadeInputs.push(input);
      return {
        workflows: { observedEffect: () => { counters.workflowEffects += 1; } },
        outbox: { observedEffect: () => { counters.outboxEffects += 1; } },
      } as never;
    },
  };
  const maintenanceFence = new RecordingMaintenanceFence(connection);
  try {
    const factory = new LifecycleWorkerRuntimeFactory({
      clock,
      identitySource: ids,
      integrity: {
        assertQuickHealthy: () => { counters.integrityChecks += 1; },
      },
      resumeSourceState: {
        captureCurrent: () => {
          counters.resumeSourceCaptures += 1;
          counters.filesystemEffects += 1;
          throw new Error("resume source state not used");
        },
      },
      checkpointSourceStateProvider: {
      capture: async (projectContext) => {
        counters.genericSourceStateCaptures += 1;
        counters.filesystemEffects += 1;
        return {
          sourceStateScopeVersion: 1,
          workspaceId: projectContext.binding.workspaceId,
          branchRef: null,
          headCommit: null,
          dirtyWorktreeFingerprint: "d".repeat(64),
        };
      },
      captureForCheckpoint: (projectContext) => {
        counters.sourceStateCaptures += 1;
        counters.filesystemEffects += 1;
        return {
          sourceStateScopeVersion: 1,
          workspaceId: projectContext.binding.workspaceId,
          branchRef: null,
          headCommit: null,
          dirtyWorktreeFingerprint: "d".repeat(64),
        };
      },
      captureForFinalization: (projectContext) => {
        counters.finalizationSourceStateCaptures += 1;
        counters.filesystemEffects += 1;
        return {
          sourceStateScopeVersion: 1,
          workspaceId: projectContext.binding.workspaceId,
          branchRef: null,
          headCommit: null,
          dirtyWorktreeFingerprint: "d".repeat(64),
        };
      },
      },
      checkpointSourceStateScopeResolver: {
      resolve: (observedConnection, projectContext) => {
        assert.equal(observedConnection, connection);
        counters.sourceStateScopes += 1;
        counters.filesystemEffects += 1;
        return Object.freeze({
          scopeVersion: 1,
          descriptorPath: projectContext.binding.descriptorPath,
          storeRoot: projectContext.binding.storeRoute.storeRoot,
          privateStateRoot: projectContext.binding.projectRoot,
          exactMaterializationTargets: Object.freeze([]),
          exactCommittedTempPaths: Object.freeze([]),
        });
      },
      },
      childBindingFingerprint: () => {
        counters.childBindingFingerprints += 1;
        return null;
      },
      repositories,
      transactionFacades,
    });
    const runtime = factory.create({ connection, maintenanceFence, keyProvider: provider });
    assert.ok(coverage !== null);
    assert.ok(projectionWriter !== null);
    return {
      connection,
      context,
      provider,
      clock,
      ids,
      counters,
      factory,
      runtime,
      authority,
      leases,
      approvals,
      transfers,
      coverage,
      projectionWriter,
      maintenanceFence,
      transactionFacades,
      cleanupRoot,
    };
  } catch (error) {
    connection.close();
    rmSync(cleanupRoot, { recursive: true, force: true });
    throw error;
  }
}

function initialPrepared(
  context: ProjectContext,
  command: RootStartCommandV2,
): PreparedLifecycleWorkerCommand<RootStartCommandV2> {
  const candidateIntentHash = buildLifecycleIntentWitness(command, {
    authorizationKind: "initial-authority",
    authorizationSessionId: null,
    targetSessionId: command.commandId,
    projectId: context.binding.projectId,
    vaultId: context.binding.vaultId,
    storeId: context.binding.storeId,
    workspaceId: context.binding.workspaceId,
    clientNamespace: context.binding.clientNamespace,
    capabilityKind: null,
    capabilityGeneration: null,
    presentingActorRole: "primary",
    presentingClientInstanceId: context.binding.clientInstanceId,
    targetActorRole: "primary",
    targetClientInstanceId: context.binding.clientInstanceId,
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).intentHash;
  return Object.freeze({
    command,
    candidateIntentHash,
    authorization: Object.freeze({
      kind: "initial-authority",
      authoritySessionId: null,
      targetSessionId: null,
      proof: null,
      approval: null,
      childBindingGrant: null,
    }),
  });
}

interface StartedRoot {
  readonly sessionId: string;
  readonly ownerGeneration: string;
  readonly material: RootOrChildAuthorityMaterial;
}

async function startRoot(item: RuntimeFixture): Promise<StartedRoot> {
  const command: RootStartCommandV2 = {
    commandType: "root-start",
    commandId: lifecycleUuid(210_000),
    idempotencyKey: "runtime/root-start",
    agentId: "runtime-agent",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    continuityKey: "runtime-root",
    resumePolicy: "new",
  };
  const response = await item.runtime.execute({
    kind: "semantic",
    operation: "root-start",
    prepared: initialPrepared(item.context, command),
  }, item.context);
  const worker = response.result as WorkerLifecycleResult<JsonValue>;
  assert.equal(worker.kind, "success");
  assert.ok(worker.authorityMaterial.descriptor !== null && worker.authorityMaterial.target !== null);
  const capabilities = new CapabilityService({
    keyProvider: item.provider,
    clock: item.clock,
    nonceSource: item.ids,
  });
  const material = capabilities.reconstructForTarget(
    worker.authorityMaterial.descriptor,
    worker.authorityMaterial.target,
  );
  const publicResult = worker.publicResult as { readonly sessionId: string; readonly ownerGeneration: string };
  return { sessionId: publicResult.sessionId, ownerGeneration: publicResult.ownerGeneration, material };
}

type PreparedRuntimeCommand =
  | RecordCheckpointCommandV2
  | RecordCheckpointCommandV3
  | RecordEvidenceBatchCommandV2;

function protectedPrepared<C extends PreparedRuntimeCommand>(
  item: RuntimeFixture,
  command: C,
  root: StartedRoot,
  authoritySessionId = root.sessionId,
): PreparedLifecycleWorkerCommand<C> {
  const candidateIntentHash = buildLifecycleIntentWitness(command, {
    authorizationKind: "protected",
    authorizationSessionId: authoritySessionId,
    targetSessionId: command.sessionId,
    projectId: item.context.binding.projectId,
    vaultId: item.context.binding.vaultId,
    storeId: item.context.binding.storeId,
    workspaceId: item.context.binding.workspaceId,
    clientNamespace: item.context.binding.clientNamespace,
    capabilityKind: "root-session-handle",
    capabilityGeneration: root.ownerGeneration,
    presentingActorRole: "primary",
    presentingClientInstanceId: item.context.binding.clientInstanceId,
    targetActorRole: "primary",
    targetClientInstanceId: item.context.binding.clientInstanceId,
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).intentHash;
  const targetSessionId = command.sessionId;
  const target: SemanticCommandProofTargetV1 = {
    proofVersion: 1,
    target: "semantic-command",
    projectId: item.context.binding.projectId,
    vaultId: item.context.binding.vaultId,
    storeId: item.context.binding.storeId,
    workspaceId: item.context.binding.workspaceId,
    clientNamespace: item.context.binding.clientNamespace,
    authoritySessionId,
    targetSessionId,
    presentingActorRole: "primary",
    presentingClientInstanceId: item.context.binding.clientInstanceId,
    targetActorRole: "primary",
    targetClientInstanceId: item.context.binding.clientInstanceId,
    capabilityKind: "root-session-handle",
    capabilityGeneration: root.ownerGeneration,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    intentHash: candidateIntentHash,
    proofNonce: lifecycleUuid(Number(command.commandId.slice(-12)) + 300_000),
  };
  return Object.freeze({
    command,
    candidateIntentHash,
    authorization: Object.freeze({
      kind: "protected",
      authoritySessionId: authoritySessionId as never,
      targetSessionId: targetSessionId as never,
      proof: createCapabilityProof(root.material.handle, target),
      approval: null,
      childBindingGrant: null,
    }),
  }) as PreparedLifecycleWorkerCommand<C>;
}

function checkpointDraft(version: 1 | 2): Record<string, unknown> {
  const fixture = version === 1 ? checkpointFixture() : qualifiedCheckpointFixture();
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
    ...draft
  } = fixture;
  return draft;
}

function checkpointCommand(root: StartedRoot, version: 1): RecordCheckpointCommandV2;
function checkpointCommand(root: StartedRoot, version: 2): RecordCheckpointCommandV3;
function checkpointCommand(
  root: StartedRoot,
  version: 1 | 2,
): RecordCheckpointCommandV2 | RecordCheckpointCommandV3 {
  const common = {
    commandType: "record-checkpoint" as const,
    commandId: lifecycleUuid(220_000),
    idempotencyKey: "runtime/checkpoint",
    agentId: "runtime-agent",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: root.sessionId as RecordCheckpointCommandV2["sessionId"],
    expectedStreamVersion: "1",
    expectedBaseEventPosition: "1",
  };
  return version === 1
    ? { ...common, draft: { checkpointVersion: 1, ...checkpointDraft(1) } } as RecordCheckpointCommandV2
    : { ...common, draft: { checkpointVersion: 2, ...checkpointDraft(2) } } as RecordCheckpointCommandV3;
}

function evidenceCommand(item: RuntimeFixture, root: StartedRoot): RecordEvidenceBatchCommandV2 {
  const keyId = item.provider.currentKey(
    { projectId: PROJECT_ID, storeId: STORE_ID },
    "evidence-fingerprint",
  ).keyId;
  return Object.freeze({
    commandType: "record-evidence-batch",
    commandId: lifecycleUuid(230_000),
    idempotencyKey: "runtime/evidence",
    agentId: "runtime-agent",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    adapterSessionId: lifecycleUuid(230_001) as RecordEvidenceBatchCommandV2["adapterSessionId"],
    batchId: lifecycleUuid(230_002) as RecordEvidenceBatchCommandV2["batchId"],
    sessionId: root.sessionId as RecordEvidenceBatchCommandV2["sessionId"],
    firstOrdinal: "0",
    lastOrdinal: "0",
    fingerprintSchemaVersion: 1,
    fingerprintKeyId: keyId,
    fingerprintDomain: "pm-evidence-frame-v1",
    redactionStatus: "content-not-retained",
    frames: Object.freeze([{
      frameId: lifecycleUuid(230_003) as RecordEvidenceBatchCommandV2["frames"][number]["frameId"],
      ordinal: "0",
      sourceKind: "model-turn" as const,
      observedAt: NOW,
      contentFingerprint: "b".repeat(64),
    }]),
  });
}

function tableCount(connection: SqliteConnection, table: string): bigint {
  return connection.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count as bigint;
}

function sqliteSnapshotValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "bigint") return `bigint:${value}`;
  if (typeof value === "number") return `number:${value}`;
  if (value instanceof Uint8Array) return `bytes:${Buffer.from(value).toString("base64")}`;
  assert.fail(`unsupported SQLite snapshot value: ${typeof value}`);
}

function allTableRows(
  connection: SqliteConnection,
): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, readonly string[]> = {};
  const tables = connection.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
  for (const row of tables) {
    assert.equal(typeof row.name, "string");
    const name = row.name as string;
    const quoted = `"${name.replaceAll('"', '""')}"`;
    result[name] = Object.freeze(connection.prepare(`SELECT * FROM ${quoted}`).all()
      .map((current) => JSON.stringify(
        Object.keys(current).sort().map((key) => [key, sqliteSnapshotValue(current[key])]),
      ))
      .sort());
  }
  return Object.freeze(result);
}

function recursiveFileSnapshot(root: string): readonly Readonly<Record<string, unknown>>[] {
  const result: Readonly<Record<string, unknown>>[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stats = statSync(path);
      const common = {
        path: relative(root, path).replaceAll("\\", "/"),
        size: stats.size,
        mode: stats.mode,
        mtimeMs: stats.mtimeMs,
      };
      if (entry.isDirectory()) {
        result.push(Object.freeze({ ...common, kind: "directory" }));
        visit(path);
      } else {
        const bytes = readFileSync(path);
        result.push(Object.freeze({
          ...common,
          kind: "file",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }));
      }
    }
  };
  visit(root);
  return Object.freeze(result.sort((left, right) =>
    String(left.path).localeCompare(String(right.path))
  ));
}

function reservedEffectSnapshot(item: RuntimeFixture): Readonly<Record<string, unknown>> {
  return Object.freeze({
    tables: allTableRows(item.connection),
    totalChanges: sqliteSnapshotValue(
      item.connection.prepare("SELECT total_changes() AS changes").get()!.changes,
    ),
    repositoryFactories: { ...item.counters.repositories },
    repositoryMethodCalls: [...item.counters.repositoryMethodCalls],
    commandFacades: item.counters.commandFacades,
    operationalFacades: item.counters.operationalFacades,
    commandFacadeInputs: item.counters.commandFacadeInputs.length,
    operationalFacadeInputs: item.counters.operationalFacadeInputs.length,
    projectionAppends: item.counters.projectionAppends,
    sourceStateScopes: item.counters.sourceStateScopes,
    sourceStateCaptures: item.counters.sourceStateCaptures,
    authorityFolds: item.counters.authorityFolds,
    coveragePrepareBatches: item.counters.coveragePrepareBatches,
    integrityChecks: item.counters.integrityChecks,
    resumeSourceCaptures: item.counters.resumeSourceCaptures,
    genericSourceStateCaptures: item.counters.genericSourceStateCaptures,
    finalizationSourceStateCaptures: item.counters.finalizationSourceStateCaptures,
    childBindingFingerprints: item.counters.childBindingFingerprints,
    workflowEffects: item.counters.workflowEffects,
    outboxEffects: item.counters.outboxEffects,
    filesystemEffects: item.counters.filesystemEffects,
    driverOpens: item.counters.driverOpens,
    identityUuidCalls: item.ids.uuidCalls,
    identityBytesCalls: item.ids.bytesCalls,
    clockNowCalls: item.clock.nowCalls,
    clockNowMsCalls: item.clock.nowMsCalls,
    providerCalls: item.provider.calls.map((call) => ({ ...call })),
    coverageProviders: item.counters.coverageProviders.length,
    projectionConnections: item.counters.projectionConnections.length,
    filesystem: recursiveFileSnapshot(item.cleanupRoot),
  });
}

function rootProofVerifications(item: RuntimeFixture): number {
  return item.provider.calls.filter((call) =>
    call.operation === "verify" && call.purpose === "root-session-handle"
  ).length;
}

function protectedFreshEffects(
  item: RuntimeFixture,
  serviceCalls: number,
): Readonly<Record<string, bigint | number>> {
  return Object.freeze({
    events: tableCount(item.connection, "events"),
    dedup: tableCount(item.connection, "command_dedup"),
    coverageTransitions: tableCount(
      item.connection,
      "session_evidence_coverage_transitions",
    ),
    projections: item.counters.projectionAppends,
    sourceStateScopes: item.counters.sourceStateScopes,
    sourceStateCaptures: item.counters.sourceStateCaptures,
    coveragePrepareBatches: item.counters.coveragePrepareBatches,
    serviceCalls,
  });
}

async function rejectsWithoutFreshEffects(
  item: RuntimeFixture,
  service: { readonly calls: number },
  wire: LifecycleWorkerOperationWire,
  context: ProjectContext,
  code: string,
  expectedFacadeDelta: number,
): Promise<void> {
  const effects = protectedFreshEffects(item, service.calls);
  const facades = item.counters.commandFacades;
  await assert.rejects(
    item.runtime.execute(wire, context),
    (error) => error instanceof LifecycleError && error.code === code,
  );
  assert.deepEqual(protectedFreshEffects(item, service.calls), effects);
  assert.equal(item.counters.commandFacades, facades + expectedFacadeDelta);
}

function forgedProof<C extends PreparedRuntimeCommand>(
  prepared: PreparedLifecycleWorkerCommand<C>,
): PreparedLifecycleWorkerCommand<C> {
  const authorization = prepared.authorization;
  assert.equal(authorization.kind, "protected");
  assert.ok(authorization.proof !== null);
  const fingerprint = authorization.proof.proofFingerprint;
  return Object.freeze({
    ...prepared,
    authorization: Object.freeze({
      ...authorization,
      proof: Object.freeze({
        ...authorization.proof,
        proofFingerprint: `${fingerprint[0] === "0" ? "1" : "0"}${fingerprint.slice(1)}`,
      }),
    }),
  }) as PreparedLifecycleWorkerCommand<C>;
}

function missingAuthority<C extends PreparedRuntimeCommand>(
  prepared: PreparedLifecycleWorkerCommand<C>,
): PreparedLifecycleWorkerCommand<C> {
  assert.equal(prepared.authorization.kind, "protected");
  return Object.freeze({
    ...prepared,
    authorization: Object.freeze({
      ...prepared.authorization,
      authoritySessionId: lifecycleUuid(290_010),
    }),
  }) as PreparedLifecycleWorkerCommand<C>;
}

function missingAuthorizationTarget<C extends PreparedRuntimeCommand>(
  prepared: PreparedLifecycleWorkerCommand<C>,
): PreparedLifecycleWorkerCommand<C> {
  assert.equal(prepared.authorization.kind, "protected");
  return Object.freeze({
    ...prepared,
    authorization: Object.freeze({
      ...prepared.authorization,
      targetSessionId: lifecycleUuid(290_011),
    }),
  }) as PreparedLifecycleWorkerCommand<C>;
}

function destroyRoot(root: StartedRoot): void {
  root.material.handle.destroy();
  if (root.material.kind === "root") root.material.resumeToken?.destroy();
}

function cleanupRuntimeFixture(item: RuntimeFixture): void {
  item.runtime.dispose();
  item.connection.close();
  rmSync(item.cleanupRoot, { recursive: true, force: true });
}

function structurallyValidFactoryOptions(
  item: RuntimeFixture,
): LifecycleWorkerRuntimeFactoryOptions {
  return {
    clock: item.clock,
    identitySource: item.ids,
    integrity: { assertQuickHealthy: () => undefined },
    resumeSourceState: { captureCurrent: () => { throw new Error("unused"); } },
    checkpointSourceStateProvider: {
      capture: async () => ({} as never),
      captureForCheckpoint: () => ({} as never),
      captureForFinalization: () => ({} as never),
    },
    checkpointSourceStateScopeResolver: { resolve: () => ({} as never) },
    childBindingFingerprint: () => null,
    repositories: {
      authority: () => item.authority,
      leases: () => item.leases,
      approvals: () => item.approvals,
      transfers: () => item.transfers,
      coverage: () => item.coverage,
      projection: () => item.projectionWriter,
    },
    transactionFacades: {
      command: () => ({} as never),
      operational: () => ({ workflows: {}, outbox: {} }),
    },
  };
}

function runtimeWithRouteRecorder(calls: string[]): ConnectionBoundLifecycleWorkerRuntime {
  const route = (name: string) => (..._arguments: unknown[]) => {
    calls.push(name);
    return { route: name };
  };
  return new ConnectionBoundLifecycleWorkerRuntime({
    rootProcessor: {
      startRoot: route("root-start"),
      resumeRoot: route("root-resume"),
      recoverRoot: route("root-recovery"),
      suspendRoot: route("root-suspend"),
      renewRootLease: route("renew-root-lease"),
    },
    childService: { execute: (_context: unknown, prepared: { command: { commandType: string } }) => {
      calls.push(prepared.command.commandType);
      return { route: prepared.command.commandType };
    } },
    checkpointHandler: { execute: route("record-checkpoint") },
    evidenceHandler: { execute: route("record-evidence-batch") },
    queryService: { read: (_context: unknown, input: { operation: string }) => {
      calls.push(input.operation);
      return { route: input.operation };
    } },
    semanticStore: { execute: route("semantic-store") },
    operationalStore: { execute: route("operational-store") },
  } as unknown as ConnectionBoundLifecycleWorkerRuntimeOptions);
}

const RESERVED_SEMANTIC = [
  ["create-child-transfer", { commandType: "create-child-transfer" }, null],
  ["request-session-end", { commandType: "request-session-end", request: { requestVersion: 1 } }, 1],
  ["request-session-end", { commandType: "request-session-end", request: { requestVersion: 2 } }, 2],
  ["amend-session-end", { commandType: "amend-session-end", amendment: { amendmentVersion: 1 } }, 1],
  ["amend-session-end", { commandType: "amend-session-end", amendment: { amendmentVersion: 2 } }, 2],
  ["cancel-session-end", { commandType: "cancel-session-end" }, null],
  ["abandon-session", { commandType: "abandon-session" }, null],
] as const;

const RESERVED_NONSEMANTIC = [
  ["internal-semantic", "internal-validation-result"],
  ["internal-semantic", "internal-workflow-phase"],
  ["fenced", "workflow-claim-next"],
  ["fenced", "workflow-claim"],
  ["fenced", "workflow-renew"],
  ["fenced", "workflow-release"],
  ["fenced", "workflow-eventless-phase"],
  ["fenced", "workflow-recovery"],
  ["fenced", "outbox-claim-next"],
  ["fenced", "outbox-claim"],
  ["fenced", "outbox-renew"],
  ["fenced", "outbox-materialize"],
  ["fenced", "outbox-failure"],
] as const;

describe("lifecycle worker runtime", () => {
  it("checkpoints run through one prepared semantic transaction", async () => {
    const service = spyCheckpointRecords();
    const item = runtimeFixture();
    let root: StartedRoot | null = null;
    try {
      root = await startRoot(item);
      const wire = {
        kind: "semantic" as const,
        operation: "record-checkpoint" as const,
        prepared: protectedPrepared(item, checkpointCommand(root, 1), root),
      };
      for (const mismatch of mismatchedActiveContexts(item.context)) {
        await rejectsWithoutFreshEffects(
          item,
          service,
          wire,
          mismatch.context,
          mismatch.code,
          0,
        );
      }
      await rejectsWithoutFreshEffects(
        item,
        service,
        { ...wire, prepared: forgedProof(wire.prepared) },
        item.context,
        "SESSION_CAPABILITY_INVALID",
        1,
      );
      await rejectsWithoutFreshEffects(
        item,
        service,
        { ...wire, prepared: missingAuthority(wire.prepared) },
        item.context,
        "SESSION_CAPABILITY_INVALID",
        0,
      );
      await rejectsWithoutFreshEffects(
        item,
        service,
        { ...wire, prepared: missingAuthorizationTarget(wire.prepared) },
        item.context,
        "SESSION_CAPABILITY_INVALID",
        0,
      );
      const missingTargetCommand = Object.freeze({
        ...checkpointCommand(root, 1),
        commandId: lifecycleUuid(220_010),
        idempotencyKey: "runtime/checkpoint-missing-target",
        sessionId: lifecycleUuid(290_011),
      }) as RecordCheckpointCommandV2;
      await rejectsWithoutFreshEffects(
        item,
        service,
        {
          kind: "semantic",
          operation: "record-checkpoint",
          prepared: protectedPrepared(
            item,
            missingTargetCommand,
            root,
            missingTargetCommand.sessionId,
          ),
        },
        item.context,
        "SESSION_NOT_FOUND",
        1,
      );
      const before = {
        events: tableCount(item.connection, "events"),
        dedup: tableCount(item.connection, "command_dedup"),
        facades: item.counters.commandFacades,
        projections: item.counters.projectionAppends,
        scopes: item.counters.sourceStateScopes,
        captures: item.counters.sourceStateCaptures,
        authorityFolds: item.counters.authorityFolds,
        proofVerifications: rootProofVerifications(item),
      };
      item.clock.current = "2026-08-02T00:00:01.000Z";
      const fresh = await item.runtime.execute(wire, item.context);
      assert.equal((fresh.result as { kind: string }).kind, "success");
      assert.equal(tableCount(item.connection, "events"), before.events + 1n);
      assert.equal(tableCount(item.connection, "command_dedup"), before.dedup + 1n);
      assert.equal(item.counters.commandFacades, before.facades + 1);
      assert.equal(item.counters.projectionAppends, before.projections + 1);
      assert.equal(item.counters.sourceStateScopes, before.scopes + 1);
      assert.equal(item.counters.sourceStateCaptures, before.captures + 1);
      assert.equal(item.counters.authorityFolds, before.authorityFolds + 2);
      assert.equal(rootProofVerifications(item), before.proofVerifications + 1);
      assert.equal(service.calls, 1);
      assert.equal(item.connection.prepare(`
        SELECT recorded_at FROM events WHERE command_id = $commandId
      `).get({ $commandId: wire.prepared.command.commandId })?.recorded_at, item.clock.current);

      const replay = await item.runtime.execute(wire, item.context);
      assert.deepEqual(replay, fresh);
      assert.equal(tableCount(item.connection, "events"), before.events + 1n);
      assert.equal(tableCount(item.connection, "command_dedup"), before.dedup + 1n);
      assert.equal(item.counters.commandFacades, before.facades + 1);
      assert.equal(item.counters.projectionAppends, before.projections + 1);
      assert.equal(item.counters.sourceStateScopes, before.scopes + 1);
      assert.equal(item.counters.sourceStateCaptures, before.captures + 1);
      assert.equal(item.counters.authorityFolds, before.authorityFolds + 2);
      assert.equal(rootProofVerifications(item), before.proofVerifications + 1);
      assert.equal(service.calls, 1);
      assert.ok(service.instance !== null);
      assert.ok(service.transaction !== null);
      assert.throws(
        () => service.instance!.record(service.transaction!, wire.prepared.command),
        (error) => error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE",
      );
      assert.equal(service.calls, 2);
      const staleCommand = Object.freeze({
        ...checkpointCommand(root, 1),
        commandId: lifecycleUuid(220_011),
        idempotencyKey: "runtime/checkpoint-stale-authority",
      }) as RecordCheckpointCommandV2;
      item.connection.prepare(`
        UPDATE session_authority
        SET semantic_state = 'suspended'
        WHERE project_id = $projectId AND session_id = $sessionId
      `).run({ $projectId: PROJECT_ID, $sessionId: root.sessionId });
      await rejectsWithoutFreshEffects(
        item,
        service,
        {
          kind: "semantic",
          operation: "record-checkpoint",
          prepared: protectedPrepared(item, staleCommand, root),
        },
        item.context,
        "SESSION_HANDLE_STALE",
        1,
      );
    } finally {
      if (root !== null) destroyRoot(root);
      cleanupRuntimeFixture(item);
      service.restore();
    }
  });

  it("evidence batches run through one prepared semantic transaction", async () => {
    const service = spyEvidenceRecords();
    const item = runtimeFixture();
    let root: StartedRoot | null = null;
    try {
      root = await startRoot(item);
      const wire = {
        kind: "semantic" as const,
        operation: "record-evidence-batch" as const,
        prepared: protectedPrepared(item, evidenceCommand(item, root), root),
      };
      for (const mismatch of mismatchedActiveContexts(item.context)) {
        await rejectsWithoutFreshEffects(
          item,
          service,
          wire,
          mismatch.context,
          mismatch.code,
          0,
        );
      }
      await rejectsWithoutFreshEffects(
        item,
        service,
        { ...wire, prepared: forgedProof(wire.prepared) },
        item.context,
        "SESSION_CAPABILITY_INVALID",
        1,
      );
      await rejectsWithoutFreshEffects(
        item,
        service,
        { ...wire, prepared: missingAuthority(wire.prepared) },
        item.context,
        "SESSION_NOT_FOUND",
        1,
      );
      const missingTargetCommand = Object.freeze({
        ...evidenceCommand(item, root),
        commandId: lifecycleUuid(230_010),
        idempotencyKey: "runtime/evidence-missing-target",
        sessionId: lifecycleUuid(290_012),
      }) as RecordEvidenceBatchCommandV2;
      await rejectsWithoutFreshEffects(
        item,
        service,
        {
          kind: "semantic",
          operation: "record-evidence-batch",
          prepared: protectedPrepared(item, missingTargetCommand, root),
        },
        item.context,
        "SESSION_NOT_FOUND",
        1,
      );
      const before = {
        events: tableCount(item.connection, "events"),
        dedup: tableCount(item.connection, "command_dedup"),
        facades: item.counters.commandFacades,
        projections: item.counters.projectionAppends,
        transitions: tableCount(item.connection, "session_evidence_coverage_transitions"),
        authorityFolds: item.counters.authorityFolds,
        coveragePrepareBatches: item.counters.coveragePrepareBatches,
        proofVerifications: rootProofVerifications(item),
      };
      const fresh = await item.runtime.execute(wire, item.context);
      assert.equal((fresh.result as { kind: string }).kind, "success");
      assert.equal(tableCount(item.connection, "events"), before.events + 1n);
      assert.equal(tableCount(item.connection, "command_dedup"), before.dedup + 1n);
      assert.equal(tableCount(item.connection, "session_evidence_coverage_transitions"), before.transitions + 1n);
      assert.equal(item.counters.commandFacades, before.facades + 1);
      assert.equal(item.counters.projectionAppends, before.projections + 1);
      assert.equal(item.counters.authorityFolds, before.authorityFolds + 1);
      assert.equal(item.counters.coveragePrepareBatches, before.coveragePrepareBatches + 1);
      assert.equal(rootProofVerifications(item), before.proofVerifications + 1);
      assert.equal(service.calls, 1);

      const replay = await item.runtime.execute(wire, item.context);
      assert.deepEqual(replay, fresh);
      assert.equal(tableCount(item.connection, "events"), before.events + 1n);
      assert.equal(tableCount(item.connection, "command_dedup"), before.dedup + 1n);
      assert.equal(tableCount(item.connection, "session_evidence_coverage_transitions"), before.transitions + 1n);
      assert.equal(item.counters.commandFacades, before.facades + 1);
      assert.equal(item.counters.projectionAppends, before.projections + 1);
      assert.equal(item.counters.authorityFolds, before.authorityFolds + 1);
      assert.equal(item.counters.coveragePrepareBatches, before.coveragePrepareBatches + 1);
      assert.equal(rootProofVerifications(item), before.proofVerifications + 1);
      assert.equal(service.calls, 1);
      assert.ok(service.instance !== null);
      assert.ok(service.transaction !== null);
      assert.throws(
        () => service.instance!.record(service.transaction!, wire.prepared.command),
        (error) => error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE",
      );
      assert.equal(service.calls, 2);
      const staleCommand = Object.freeze({
        ...evidenceCommand(item, root),
        commandId: lifecycleUuid(230_011),
        idempotencyKey: "runtime/evidence-stale-authority",
      }) as RecordEvidenceBatchCommandV2;
      item.connection.prepare(`
        UPDATE session_authority
        SET semantic_state = 'suspended'
        WHERE project_id = $projectId AND session_id = $sessionId
      `).run({ $projectId: PROJECT_ID, $sessionId: root.sessionId });
      await rejectsWithoutFreshEffects(
        item,
        service,
        {
          kind: "semantic",
          operation: "record-evidence-batch",
          prepared: protectedPrepared(item, staleCommand, root),
        },
        item.context,
        "SESSION_HANDLE_STALE",
        1,
      );
    } finally {
      if (root !== null) destroyRoot(root);
      cleanupRuntimeFixture(item);
      service.restore();
    }
  });
  it("reserves future lifecycle handlers before every side effect", async () => {
    const item = runtimeFixture();
    try {
      const before = reservedEffectSnapshot(item);
      for (const [operation, command, nestedContractVersion] of RESERVED_SEMANTIC) {
        const result = await item.runtime.execute({
          kind: "semantic",
          operation,
          prepared: { command },
        } as unknown as LifecycleWorkerOperationWire, item.context);
        assert.deepEqual(result, {
          operation,
          nestedContractVersion,
          result: { kind: "rejected", errorCode: "LIFECYCLE_OPERATION_UNAVAILABLE" },
        });
        assert.deepEqual(
          reservedEffectSnapshot(item),
          before,
          `${operation} crossed a reserved side-effect boundary`,
        );
      }

      for (const [kind, operation] of RESERVED_NONSEMANTIC) {
        await assert.rejects(
          item.runtime.execute(
            { kind, operation } as unknown as LifecycleWorkerOperationWire,
            item.context,
          ),
          (error) => error instanceof LifecycleError
            && error.code === "LIFECYCLE_OPERATION_UNAVAILABLE",
        );
        assert.deepEqual(
          reservedEffectSnapshot(item),
          before,
          `${operation} crossed a reserved side-effect boundary`,
        );
      }
      assert.deepEqual(reservedEffectSnapshot(item), before);
    } finally {
      cleanupRuntimeFixture(item);
    }

    const routed: string[] = [];
    const routedRuntime = runtimeWithRouteRecorder(routed);
    for (const [operation, command] of RESERVED_SEMANTIC) {
      await routedRuntime.execute({
        kind: "semantic",
        operation,
        prepared: { command },
      } as unknown as LifecycleWorkerOperationWire, PROJECT_CONTEXT);
    }
    for (const [kind, operation] of RESERVED_NONSEMANTIC) {
      await assert.rejects(
        routedRuntime.execute(
          { kind, operation } as unknown as LifecycleWorkerOperationWire,
          PROJECT_CONTEXT,
        ),
        (error) => error instanceof LifecycleError
          && error.code === "LIFECYCLE_OPERATION_UNAVAILABLE",
      );
    }
    assert.deepEqual(routed, []);
    const semanticRoutes = [
      ["root-start", { commandType: "root-start" }],
      ["root-resume", { commandType: "root-resume" }],
      ["root-recovery", { commandType: "root-recovery" }],
      ["root-suspend", { commandType: "root-suspend", checkpoint: { checkpointVersion: 1 } }],
      ["fork-child", { commandType: "fork-child" }],
      ["amend-child-assignment", { commandType: "amend-child-assignment" }],
      ["record-child-report", { commandType: "record-child-report" }],
      ["disposition-child-report", { commandType: "disposition-child-report" }],
      ["propose-child-completion", { commandType: "propose-child-completion" }],
      ["complete-child-session", { commandType: "complete-child-session" }],
      ["suspend-child-session", { commandType: "suspend-child-session" }],
      ["claim-child-transfer", { commandType: "claim-child-transfer" }],
      ["record-checkpoint", { commandType: "record-checkpoint", draft: { checkpointVersion: 1 } }],
      ["record-evidence-batch", { commandType: "record-evidence-batch" }],
    ] as const;
    for (const [operation, command] of semanticRoutes) {
      await routedRuntime.execute({
        kind: "semantic",
        operation,
        prepared: { command },
      } as unknown as LifecycleWorkerOperationWire, PROJECT_CONTEXT);
    }
    await routedRuntime.execute({
      kind: "bounded",
      operation: "renew-root-lease",
      input: { operation: "renew-root-lease", authorization: {} },
    } as unknown as LifecycleWorkerOperationWire, PROJECT_CONTEXT);
    for (const operation of [
      "read-session-tree",
      "read-session-status",
      "read-session-association",
    ] as const) {
      await routedRuntime.execute({
        kind: "query",
        operation,
        input: { operation, authorization: {} },
      } as unknown as LifecycleWorkerOperationWire, PROJECT_CONTEXT);
    }
    assert.deepEqual(routed, [
      ...semanticRoutes.map(([operation]) => operation),
      "renew-root-lease",
      "read-session-tree",
      "read-session-status",
      "read-session-association",
    ]);
    routedRuntime.dispose();
    await assert.rejects(
      routedRuntime.execute({
        kind: "query",
        operation: "read-session-status",
        input: { operation: "read-session-status", authorization: {} },
      } as unknown as LifecycleWorkerOperationWire, PROJECT_CONTEXT),
      (error) => error instanceof LifecycleError && error.code === "LIFECYCLE_V2_DISABLED",
    );
  });
  it("conflicts cross-version checkpoint identity reuse", async () => {
    const item = runtimeFixture();
    let root: StartedRoot | null = null;
    try {
      root = await startRoot(item);
      const version1 = {
        kind: "semantic" as const,
        operation: "record-checkpoint" as const,
        prepared: protectedPrepared(item, checkpointCommand(root, 1), root),
      };
      await item.runtime.execute(version1, item.context);
      await item.runtime.execute(version1, item.context);
      const before = {
        events: tableCount(item.connection, "events"),
        dedup: tableCount(item.connection, "command_dedup"),
        projections: item.counters.projectionAppends,
        scopes: item.counters.sourceStateScopes,
      };
      const version2 = {
        kind: "semantic" as const,
        operation: "record-checkpoint" as const,
        prepared: protectedPrepared(item, checkpointCommand(root, 2), root),
      };
      await assert.rejects(
        item.runtime.execute(version2, item.context),
        (error) => typeof error === "object" && error !== null
          && "code" in error && error.code === "IDEMPOTENCY_CONFLICT",
      );
      assert.equal(tableCount(item.connection, "events"), before.events);
      assert.equal(tableCount(item.connection, "command_dedup"), before.dedup);
      assert.equal(item.counters.projectionAppends, before.projections);
      assert.equal(item.counters.sourceStateScopes, before.scopes);
    } finally {
      if (root !== null) destroyRoot(root);
      cleanupRuntimeFixture(item);
    }
  });

  it("constructs one connection-bound runtime with exact factory ownership", async () => {
    const item = runtimeFixture();
    let root: StartedRoot | null = null;
    try {
      assert.ok(item.runtime instanceof ConnectionBoundLifecycleWorkerRuntime);
      assert.deepEqual(item.counters.repositories, {
        authority: 1,
        leases: 1,
        approvals: 1,
        transfers: 1,
        coverage: 1,
        projection: 1,
      });
      assert.deepEqual(item.counters.coverageProviders, [item.provider]);
      assert.deepEqual(item.counters.projectionConnections, [item.connection]);
      assert.equal(item.counters.driverOpens, 1);
      assert.equal(item.counters.commandFacades, 0);
      assert.equal(item.counters.operationalFacades, 0);

      const projectionAppends = item.counters.projectionAppends;
      const fenceChecks = item.maintenanceFence.appendChecks;
      const identityBytes = item.ids.bytesCalls;
      item.clock.current = "2026-08-02T00:00:09.000Z";
      root = await startRoot(item);
      assert.equal(item.counters.commandFacades, 1);
      const input = item.counters.commandFacadeInputs[0] as Record<string, unknown>;
      assert.equal(input.connection, item.connection);
      assert.equal(input.authority, item.authority);
      assert.equal(input.leases, item.leases);
      assert.equal(input.approvals, item.approvals);
      assert.equal(input.transfers, item.transfers);
      assert.equal(input.coverage, item.coverage);
      assert.equal(item.counters.projectionAppends, projectionAppends + 1);
      assert.equal(item.maintenanceFence.appendChecks, fenceChecks + 1);
      assert.equal(item.ids.bytesCalls, identityBytes + 2);
      assert.deepEqual(item.maintenanceFence.observedConnections, [item.connection]);
      assert.equal(item.connection.prepare(`
        SELECT recorded_at FROM events WHERE command_id = $commandId
      `).get({ $commandId: lifecycleUuid(210_000) })?.recorded_at, item.clock.current);
      assert.equal(item.counters.driverOpens, 1);

      const operationalFacades = item.counters.operationalFacades;
      const operational = item.transactionFacades.operational({ connection: item.connection });
      assert.ok(typeof operational.workflows === "object");
      assert.ok(typeof operational.outbox === "object");
      assert.equal(item.counters.operationalFacades, operationalFacades + 1);
      assert.deepEqual(item.counters.operationalFacadeInputs.slice(-1), [{
        connection: item.connection,
      }]);

      const factorySource = readFileSync(join(
        process.cwd(),
        "src/orchestrator/runtime/lifecycle-worker-runtime.factory.ts",
      ), "utf8");
      assert.equal(factorySource.match(/\bnew CapabilityService\s*\(/g)?.length ?? 0, 1);
      assert.match(factorySource, /new CapabilityService\(\{\s*keyProvider: input\.keyProvider,\s*clock: options\.clock,\s*nonceSource: options\.identitySource,\s*\}\)/);
      assert.match(factorySource, /new EventAppendTransaction\(\s*input\.connection,\s*new SqliteEventAppendStatements\(input\.connection\),\s*input\.maintenanceFence,\s*new BranchScopeRepository\(\{\s*randomId: \(\) => options\.identitySource\.uuid\(\) as BranchScopeId,\s*\}\),\s*\(\) => options\.identitySource\.uuid\(\),\s*NO_EVENT_STORE_FAULTS,\s*\)/);
      assert.match(factorySource, /new LifecycleCommandStore\(\{\s*connection: input\.connection,\s*events,\s*projectionWriter,/);
      assert.match(factorySource, /new LifecycleOperationalStore\(\{\s*connection: input\.connection,\s*transaction: \(connection\) => \{\s*if \(connection !== input\.connection\) return integrityFailure\(\);\s*return options\.transactionFacades\.operational\(\{ connection \}\);/);
      assert.equal(
        factorySource.match(/\bnew ConnectionBoundLifecycleWorkerRuntime\s*\(/g)?.length ?? 0,
        1,
      );
      assert.match(factorySource, /new ConnectionBoundLifecycleWorkerRuntime\(\{\s*rootProcessor,\s*childService,\s*checkpointHandler,\s*evidenceHandler,\s*queryService,\s*semanticStore,\s*operationalStore,\s*\}\)/);
      assert.doesNotMatch(factorySource, /\b(?:NodeSqliteDriver|DatabaseSync)\b|\.open\s*\(/);

      const validOptions = structurallyValidFactoryOptions(item);
      for (const accessorKey of Reflect.ownKeys(validOptions)) {
        const options = Object.create(null) as Record<PropertyKey, unknown>;
        for (const [key, value] of Object.entries(validOptions)) {
          Object.defineProperty(options, key, key === accessorKey
            ? { enumerable: true, get: () => { throw new Error("ACCESSOR_INVOKED"); } }
            : { enumerable: true, value });
        }
        assert.throws(
          () => new LifecycleWorkerRuntimeFactory(
            options as unknown as LifecycleWorkerRuntimeFactoryOptions,
          ),
          (error) => error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE",
        );
      }

      const validCreateInput = {
        connection: item.connection,
        maintenanceFence: item.maintenanceFence,
        keyProvider: item.provider,
      };
      const repositoryCounts = { ...item.counters.repositories };
      for (const accessorKey of Reflect.ownKeys(validCreateInput)) {
        const createInput = Object.create(null) as Record<PropertyKey, unknown>;
        for (const [key, value] of Object.entries(validCreateInput)) {
          Object.defineProperty(createInput, key, key === accessorKey
            ? { enumerable: true, get: () => { throw new Error("ACCESSOR_INVOKED"); } }
            : { enumerable: true, value });
        }
        assert.throws(
          () => item.factory.create(createInput as unknown as LifecycleWorkerRuntimeCreateInput),
          (error) => error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE",
        );
      }
      assert.deepEqual(item.counters.repositories, repositoryCounts);
    } finally {
      if (root !== null) destroyRoot(root);
      cleanupRuntimeFixture(item);
    }
  });
});
