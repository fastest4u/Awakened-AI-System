import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, before, describe, it } from "node:test";
import type { AppendCommand, JsonValue } from "../src/orchestrator/contracts/event.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import { EventIntegrityService } from "../src/orchestrator/integrity/event-integrity.service.js";
import { LifecycleIntegrityService } from "../src/orchestrator/integrity/lifecycle-integrity.service.js";
import {
  createCapabilityProof,
  type BoundedOperationProofTargetV1,
  type SemanticCommandProofTargetV1,
} from "../src/orchestrator/lifecycle/authority/capability-codec.js";
import {
  CHILD_BINDING_GRANT_DOMAIN,
  type ChildBindingGrantV1,
  type WorkerLifecycleResult,
} from "../src/orchestrator/lifecycle/authority/authority-material-adapter.js";
import { CapabilityService, type RootOrChildAuthorityMaterial } from "../src/orchestrator/lifecycle/capability.service.js";
import type {
  AmendChildAssignmentCommandV2,
  ClaimChildTransferCommandV2,
  CompleteChildSessionCommandV2,
  DispositionChildReportCommandV2,
  ForkChildCommandV2,
  PreparedLifecycleWorkerCommand,
  ProposeChildCompletionCommandV2,
  RecordChildReportCommandV2,
  RootResumeCommandV2,
  RootStartCommandV2,
  RootSuspendCommandV2,
  SuspendChildSessionCommandV2,
} from "../src/orchestrator/lifecycle/contracts/commands.js";
import type { ChildDispositionV1, ChildReportDraftV1 } from "../src/orchestrator/lifecycle/contracts/child.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import { LifecycleCommandProcessor } from "../src/orchestrator/lifecycle/lifecycle-command.processor.js";
import {
  LifecycleCommandStore,
  type ConnectionBoundEvidenceCoverage,
} from "../src/orchestrator/lifecycle/lifecycle-command.store.js";
import {
  CHECKPOINT_MAX_CANONICAL_BYTES,
  type CheckpointEvidenceCoverageV2,
} from "../src/orchestrator/lifecycle/contracts/checkpoint.js";
import {
  minimumCheckpointUpperBound,
  minimumFinalEndingScopeBindingsUpperBound,
  type MinimumCheckpointCapacityInput,
  type MinimumEndingScopeCapacityInput,
} from "../src/orchestrator/lifecycle/checkpoint-capacity.js";
import {
  FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES,
  type FinalEndingScopeBindingV1,
} from "../src/orchestrator/lifecycle/contracts/session-end.js";
import {
  LifecycleQueryService,
  type ProtectedSessionTreeReadOperation,
} from "../src/orchestrator/lifecycle/lifecycle-query.service.js";
import { buildLifecycleIntentWitness } from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { ChildTransferRepository } from "../src/orchestrator/storage/child-transfer.repository.js";
import {
  EventAppendTransaction,
  SqliteEventAppendStatements,
} from "../src/orchestrator/storage/event-append-transaction.js";
import { LifecycleApprovalRepository } from "../src/orchestrator/storage/lifecycle-approval.repository.js";
import type {
  CarryForwardEndingScopeProjectionRecord,
  CurrentChildEndingScopeProjectionRecord,
  SessionAuthorityRecord,
} from "../src/orchestrator/storage/lifecycle-storage.types.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { MigrationRunner } from "../src/orchestrator/storage/migration-runner.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { SessionAuthorityRepository } from "../src/orchestrator/storage/session-authority.repository.js";
import { SessionLeaseRepository } from "../src/orchestrator/storage/session-lease.repository.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";
import { DeterministicCapabilityKeyProvider } from "./support/lifecycle-authority-reference.js";
import {
  PROJECT_ID,
  STORE_ID,
  VAULT_ID,
  WORKSPACE_ID,
  checkpointFixture,
  lifecycleUuid,
} from "./support/lifecycle-fixtures.js";
import {
  compareCanonicalUtf8,
  referenceMinimumCheckpointUpperBound,
  referenceMinimumFinalEndingScopeBindingsUpperBound,
} from "./support/qualified-checkpoint-reference.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";

const NOW = "2026-07-18T00:00:00.000Z";
const LIFECYCLE_SCHEMA_MIGRATIONS = PROJECT_STORE_MIGRATIONS.slice(0, 2);
const NOW_MS = BigInt(Date.parse(NOW));
const TARGET_BINDING_FINGERPRINT = "d".repeat(64);

function healthyCoverageFacade(
  overrides: Partial<ConnectionBoundEvidenceCoverage> = {},
): ConnectionBoundEvidenceCoverage {
  return {
    assertEvidenceWindowWritable: () => undefined,
    assertQuickHealthy: () => undefined,
    registerAffectedExistingSessions: () => undefined,
    assertVersion1Eligible: () => undefined,
    prepareBatch: () => { throw new Error("evidence coverage not used"); },
    persistPrepared: () => undefined,
    snapshotV2: () => Object.freeze({
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: Object.freeze([]),
    }),
    minimumCheckpointUpperBound: () => 0,
    minimumFinalEndingScopeBindingsUpperBound: () => 0,
    ...overrides,
  };
}

class NativeStatement implements SqliteStatement {
  constructor(private readonly statement: import("node:sqlite").StatementSync) {
    statement.setReadBigInts(true);
  }

  run(params?: SqliteParams): SqliteRunResult {
    const result = params === undefined ? this.statement.run() : this.statement.run(params);
    return { changes: result.changes as bigint, lastInsertRowid: result.lastInsertRowid as bigint };
  }

  get(params?: SqliteParams): SqliteRow | undefined {
    return (params === undefined ? this.statement.get() : this.statement.get(params)) as SqliteRow | undefined;
  }

  all(params?: SqliteParams): SqliteRow[] {
    return (params === undefined ? this.statement.all() : this.statement.all(params)) as SqliteRow[];
  }

  iterate(params?: SqliteParams): IterableIterator<SqliteRow> {
    return (params === undefined ? this.statement.iterate() : this.statement.iterate(params)) as IterableIterator<SqliteRow>;
  }
}

class NativeConnection implements SqliteConnection {
  readonly database: DatabaseSync;

  constructor(databasePath = ":memory:") {
    this.database = new DatabaseSync(databasePath, {
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
  }

  exec(sql: string): void { this.database.exec(sql); }
  prepare(sql: string): SqliteStatement { return new NativeStatement(this.database.prepare(sql)); }
  close(): void { this.database.close(); }
}

class DeterministicIds {
  #next = 10_000;
  uuidCalls = 0;
  bytesCalls = 0;
  uuid(): string {
    this.uuidCalls += 1;
    return lifecycleUuid(this.#next++);
  }
  bytes(length: number): Uint8Array {
    this.bytesCalls += 1;
    return Buffer.alloc(length, this.#next++ % 251);
  }
}

class TestClock {
  now = NOW_MS;
  nowMs(): bigint { return this.now; }
}

function context(
  clientInstanceId = "primary-1",
  actorRole: ProjectContext["binding"]["actorRole"] = "primary",
): ProjectContext {
  const workspace = { kind: "non-git" as const, workspaceRoot: "C:\\project", workspaceId: WORKSPACE_ID };
  return {
    binding: {
      projectBindingId: `binding-${clientInstanceId}`,
      generation: 1,
      contextFingerprint: createHash("sha256").update(clientInstanceId).digest("hex"),
      source: "explicit-cli",
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "desktop/tests",
      clientInstanceId,
      actorRole,
      projectRoot: "C:\\project",
      vaultRoot: "C:\\project\\memory",
      descriptorPath: "C:\\project\\memory\\.project-memory.json",
      storeRoute: {
        kind: "vault-local",
        storeRoot: "C:\\project\\memory\\.memory-mcp",
        eventsPath: "C:\\project\\memory\\.memory-mcp\\events.sqlite",
        storeManifestPath: "C:\\project\\memory\\.memory-mcp\\store.json",
        projectionManifestPath: "C:\\project\\memory\\.memory-mcp\\projection.json",
      },
      workspace,
      establishedAt: NOW,
    },
    workspace,
    checkedAt: NOW,
  };
}

function startCommand(ordinal: number): RootStartCommandV2 {
  return {
    commandType: "root-start",
    commandId: lifecycleUuid(ordinal),
    idempotencyKey: `root-start/${ordinal}`,
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    continuityKey: `thread-${ordinal}`,
    resumePolicy: "new",
  };
}

function preparedStart(projectContext: ProjectContext, command: RootStartCommandV2): PreparedLifecycleWorkerCommand<RootStartCommandV2> {
  const candidateIntentHash = buildLifecycleIntentWitness(command, {
    authorizationKind: "initial-authority",
    authorizationSessionId: null,
    targetSessionId: lifecycleUuid(99_999),
    projectId: projectContext.binding.projectId,
    vaultId: projectContext.binding.vaultId,
    storeId: projectContext.binding.storeId,
    workspaceId: projectContext.binding.workspaceId,
    clientNamespace: projectContext.binding.clientNamespace,
    capabilityKind: null,
    capabilityGeneration: null,
    presentingActorRole: "primary",
    presentingClientInstanceId: projectContext.binding.clientInstanceId,
    targetActorRole: "primary",
    targetClientInstanceId: projectContext.binding.clientInstanceId,
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).intentHash;
  return {
    command,
    candidateIntentHash,
    authorization: {
      kind: "initial-authority",
      authoritySessionId: null,
      targetSessionId: null,
      proof: null,
      approval: null,
      childBindingGrant: null,
    },
  };
}

function resumeCommand(
  item: Fixture,
  ordinal: number,
): RootResumeCommandV2 {
  return {
    commandType: "root-resume",
    commandId: lifecycleUuid(ordinal),
    idempotencyKey: `root-resume/${ordinal}`,
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: item.root.publicResult.sessionId as RootResumeCommandV2["sessionId"],
    continuityKey: "thread-100",
    resumePolicy: "exact",
    expectedOwnerGeneration: item.root.publicResult.ownerGeneration,
  };
}

function preparedResume(
  item: Fixture,
  projectContext: ProjectContext,
  command: RootResumeCommandV2,
): PreparedLifecycleWorkerCommand<RootResumeCommandV2> {
  assert.equal(item.rootAuthority.kind, "root");
  if (item.rootAuthority.kind !== "root" || item.rootAuthority.resumeToken === null) {
    assert.fail("root resume token must be available");
  }
  const candidateIntentHash = buildLifecycleIntentWitness(command, {
    authorizationKind: "protected",
    authorizationSessionId: item.root.publicResult.sessionId,
    targetSessionId: item.root.publicResult.sessionId,
    projectId: projectContext.binding.projectId,
    vaultId: projectContext.binding.vaultId,
    storeId: projectContext.binding.storeId,
    workspaceId: projectContext.binding.workspaceId,
    clientNamespace: projectContext.binding.clientNamespace,
    capabilityKind: "root-resume-token",
    capabilityGeneration: command.expectedOwnerGeneration,
    presentingActorRole: "primary",
    presentingClientInstanceId: projectContext.binding.clientInstanceId,
    targetActorRole: "primary",
    targetClientInstanceId: projectContext.binding.clientInstanceId,
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).intentHash;
  const target: SemanticCommandProofTargetV1 = {
    proofVersion: 1,
    target: "semantic-command",
    projectId: projectContext.binding.projectId,
    vaultId: projectContext.binding.vaultId,
    storeId: projectContext.binding.storeId,
    workspaceId: projectContext.binding.workspaceId,
    clientNamespace: projectContext.binding.clientNamespace,
    authoritySessionId: item.root.publicResult.sessionId,
    targetSessionId: item.root.publicResult.sessionId,
    presentingActorRole: "primary",
    presentingClientInstanceId: projectContext.binding.clientInstanceId,
    targetActorRole: "primary",
    targetClientInstanceId: projectContext.binding.clientInstanceId,
    capabilityKind: "root-resume-token",
    capabilityGeneration: command.expectedOwnerGeneration,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    intentHash: candidateIntentHash,
    proofNonce: lifecycleUuid(Number(command.commandId.slice(-12)) + 50_000),
  };
  return {
    command,
    candidateIntentHash,
    authorization: {
      kind: "protected",
      authoritySessionId: item.root.publicResult.sessionId as NonNullable<RootResumeCommandV2["sessionId"]>,
      targetSessionId: item.root.publicResult.sessionId as NonNullable<RootResumeCommandV2["sessionId"]>,
      proof: createCapabilityProof(item.rootAuthority.resumeToken, target),
      approval: null,
      childBindingGrant: null,
    },
  };
}

type ProtectedTreeRead = ProtectedSessionTreeReadOperation;

function protectedTreeRead(item: Fixture, ordinal: number): ProtectedTreeRead {
  const operationId = lifecycleUuid(ordinal);
  const requestId = lifecycleUuid(ordinal + 10_000);
  const sessionId = item.root.publicResult.sessionId;
  const operationHash = createHash("sha256")
    .update("project-memory/bounded-operation/v1\n", "utf8")
    .update(canonicalJson({
      operationType: "read-session-tree",
      operationId,
      requestId,
      sessionId,
    }), "utf8")
    .digest("hex");
  const audience = {
    presentingActorRole: "primary" as const,
    presentingClientInstanceId: item.primary.binding.clientInstanceId,
    targetActorRole: "primary" as const,
    targetClientInstanceId: item.primary.binding.clientInstanceId,
  };
  const target: BoundedOperationProofTargetV1 = {
    proofVersion: 1,
    target: "bounded-operation",
    operationType: "read-session-tree",
    operationId,
    requestId,
    operationHash,
    authoritySessionId: sessionId,
    targetSessionId: sessionId,
    ...audience,
    capabilityGeneration: item.root.publicResult.ownerGeneration,
    proofNonce: lifecycleUuid(ordinal + 20_000),
    expiresAt: new Date(Number(NOW_MS + 120_000n)).toISOString(),
  };
  return {
    context: item.primary,
    operation: "read-session-tree",
    operationId,
    requestId,
    sessionId: sessionId as ProtectedTreeRead["sessionId"],
    authorization: {
      kind: "bounded-operation",
      authoritySessionId: sessionId as ProtectedTreeRead["authorization"]["authoritySessionId"],
      targetSessionId: sessionId as ProtectedTreeRead["authorization"]["targetSessionId"],
      proof: createCapabilityProof(item.rootAuthority.handle, target),
      audience,
    },
  };
}

type ChildWorkflowResultV2 = JsonValue & {
  readonly operation: string;
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly directAccessEnabled?: boolean;
  readonly rootOwnerGeneration?: string;
  readonly assignment?: { readonly assignmentId: string; readonly summary: string; readonly scope: string };
  readonly assignmentRevision?: string;
  readonly reportId?: string;
  readonly reportItemIds?: readonly string[];
  readonly disposition?: { readonly kind: string; readonly reportId: string };
  readonly state?: string;
  readonly transferTicketId?: string;
  readonly previousChildSessionId?: string;
  readonly eventPosition?: string;
  readonly finalStreamVersion?: string;
};

interface ChildWorkflowServiceLike {
  execute(
    projectContext: ProjectContext,
    command: PreparedLifecycleWorkerCommand<Exclude<
      import("../src/orchestrator/lifecycle/contracts/commands.js").LifecycleSemanticCommandDraft,
      RootStartCommandV2
    >>,
  ): WorkerLifecycleResult<ChildWorkflowResultV2>;
}

type ChildWorkflowServiceConstructor = new (options: Record<string, unknown>) => ChildWorkflowServiceLike;

let ChildWorkflowServiceClass: ChildWorkflowServiceConstructor | null = null;

before(async () => {
  const modulePath = ["../src/orchestrator/lifecycle/child-workflow", ".service.js"].join("");
  try {
    const loaded = await import(modulePath) as { readonly ChildWorkflowService?: ChildWorkflowServiceConstructor };
    ChildWorkflowServiceClass = loaded.ChildWorkflowService ?? null;
  } catch (error) {
    if ((error as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
});

interface RootStartSuccess {
  readonly kind: "success";
  readonly publicResult: { readonly sessionId: string; readonly ownerGeneration: string; readonly eventPosition: string };
  readonly authorityMaterial: Exclude<WorkerLifecycleResult<JsonValue>, { kind: "rejected" | "unknown" }> extends infer _T
    ? {
        readonly target: { readonly actorRole: "primary" | "untrusted"; readonly clientInstanceId: string } | null;
        readonly descriptor: import("../src/orchestrator/lifecycle/capability.service.js").AuthorityMaterialDescriptorV1 | null;
      }
    : never;
}

interface Fixture {
  readonly connection: NativeConnection;
  readonly authority: SessionAuthorityRepository;
  readonly leases: SessionLeaseRepository;
  readonly approvals: LifecycleApprovalRepository;
  readonly transfers: ChildTransferRepository;
  readonly events: EventAppendTransaction;
  readonly store: LifecycleCommandStore;
  readonly processor: LifecycleCommandProcessor;
  readonly query: LifecycleQueryService;
  readonly capabilities: CapabilityService;
  readonly provider: DeterministicCapabilityKeyProvider;
  readonly clock: TestClock;
  readonly ids: DeterministicIds;
  readonly workflow: ChildWorkflowServiceLike;
  readonly primary: ProjectContext;
  readonly childContext: ProjectContext;
  readonly root: RootStartSuccess;
  readonly rootAuthority: RootOrChildAuthorityMaterial;
  readonly childAuthorities: RootOrChildAuthorityMaterial[];
  readonly additionalConnections: NativeConnection[];
  readonly cleanupDirectory: string | null;
  readonly checkpointSourceCaptures: { count: number };
  readonly resumeSourceCaptures: { count: number };
}

const fixtures: Fixture[] = [];

interface EndingScopeProjectionOverrides {
  readonly children?: (
    projectId: string,
    rootSessionId: string,
    limit: number,
  ) => readonly CurrentChildEndingScopeProjectionRecord[];
  readonly tickets?: (
    projectId: string,
    rootSessionId: string,
    limit: number,
  ) => readonly CarryForwardEndingScopeProjectionRecord[];
}

function commandRuntime(options: {
  readonly connection: NativeConnection;
  readonly authority: SessionAuthorityRepository;
  readonly leases: SessionLeaseRepository;
  readonly approvals: LifecycleApprovalRepository;
  readonly transfers: ChildTransferRepository;
  readonly ids: DeterministicIds;
  readonly clock: TestClock;
  readonly coverage?: ConnectionBoundEvidenceCoverage;
  readonly endingScopeProjections?: EndingScopeProjectionOverrides;
}): { readonly events: EventAppendTransaction; readonly store: LifecycleCommandStore } {
  const {
    connection,
    authority,
    leases,
    approvals,
    transfers,
    ids,
    clock,
    coverage,
    endingScopeProjections,
  } = options;
  const childAuthority = authority as SessionAuthorityRepository & {
    nextGlobalPosition(current: SqliteConnection): bigint;
    loadEvents(current: SqliteConnection, input: SessionAuthorityRecord): readonly unknown[];
  };
  const events = new EventAppendTransaction(
    connection,
    new SqliteEventAppendStatements(connection),
    new MaintenanceFence(),
    new BranchScopeRepository(),
    () => ids.uuid(),
  );
  const store = new LifecycleCommandStore({
    connection,
    events,
    transaction: (current) => ({
      authority: {
        get: (projectId: string, sessionId: string) => authority.get(current, projectId, sessionId),
        insertRoot: (input: Parameters<SessionAuthorityRepository["insertRoot"]>[1]) => authority.insertRoot(current, input),
        insertChild: (input: Parameters<SessionAuthorityRepository["insertChild"]>[1]) => authority.insertChild(current, input),
        compareAndSwap: (input: Parameters<SessionAuthorityRepository["compareAndSwap"]>[1]) => authority.compareAndSwap(current, input),
        listSafeResumeCandidates: (input: Parameters<SessionAuthorityRepository["listSafeResumeCandidates"]>[1]) => authority.listSafeResumeCandidates(current, input),
        listNonterminalRootContinuityOwners: (input: Parameters<SessionAuthorityRepository["listNonterminalRootContinuityOwners"]>[1]) => authority.listNonterminalRootContinuityOwners(current, input),
        listNonterminalChildren: (projectId: string, rootSessionId: string) => authority.listNonterminalChildren(current, projectId, rootSessionId),
        listNonterminalChildEndingScopeProjectionsBounded: (
          projectId: string,
          rootSessionId: string,
          limit: number,
        ) => endingScopeProjections?.children?.(
          projectId,
          rootSessionId,
          limit,
        ) ?? authority.listNonterminalChildEndingScopeProjectionsBounded(
            current,
            projectId,
            rootSessionId,
            limit,
          ),
        latestCheckpoint: (input: SessionAuthorityRecord) => authority.latestCheckpoint(current, input),
        rootContinuityKey: (input: SessionAuthorityRecord) => authority.rootContinuityKey(current, input),
        nextGlobalPosition: () => childAuthority.nextGlobalPosition(current),
        loadEvents: (input: SessionAuthorityRecord) => childAuthority.loadEvents(current, input),
        requireFoldMatch: (input: SessionAuthorityRecord) => authority.requireFoldMatch(current, input),
        markCheckpointRequired: (input: Parameters<SessionAuthorityRepository["markCheckpointRequired"]>[1]) => authority.markCheckpointRequired(current, input),
      },
      leases: {
        current: (projectId: string, sessionId: string) => leases.current(current, projectId, sessionId),
        isExpired: (lease: Parameters<SessionLeaseRepository["isExpired"]>[0], now: bigint) => leases.isExpired(lease, now),
        insertGeneration: (input: Parameters<SessionLeaseRepository["insertGeneration"]>[1]) => leases.insertGeneration(current, input),
        renewCurrent: (input: Parameters<SessionLeaseRepository["renewCurrent"]>[1]) => leases.renewCurrent(current, input),
        releaseCurrent: (input: Parameters<SessionLeaseRepository["releaseCurrent"]>[1]) => leases.releaseCurrent(current, input),
      },
      approvals: { consume: (input: Parameters<LifecycleApprovalRepository["consume"]>[1]) => approvals.consume(current, input) },
      transfers: {
        get: (projectId: string, ticketId: string) => transfers.get(current, projectId, ticketId),
        findCreatedEventPosition: (projectId: string, ticketId: string) =>
          transfers.findCreatedEventPosition(current, projectId, ticketId),
        listUnclaimedEndingScopeProjectionsBySourceRoot: (
          projectId: string,
          sourceRootSessionId: string,
          limit: number,
        ) => endingScopeProjections?.tickets?.(
          projectId,
          sourceRootSessionId,
          limit,
        ) ?? transfers.listUnclaimedEndingScopeProjectionsBySourceRoot(
            current,
            projectId,
            sourceRootSessionId,
            limit,
          ),
        insert: (input: Parameters<ChildTransferRepository["insert"]>[1]) => transfers.insert(current, input),
        claim: (input: Parameters<ChildTransferRepository["claim"]>[1]) => transfers.claim(current, input),
      },
      coverage: coverage ?? healthyCoverageFacade(), workflows: {}, validation: {}, outbox: {},
    }),
    now: () => new Date(Number(clock.nowMs())).toISOString(),
  });
  return { events, store };
}

function fixture(
  databasePath = ":memory:",
  cleanupDirectory: string | null = null,
  coverage?: ConnectionBoundEvidenceCoverage,
  endingScopeProjections?: EndingScopeProjectionOverrides,
): Fixture {
  assert.ok(ChildWorkflowServiceClass, "ChildWorkflowService must implement scoped child behavior");
  const connection = new NativeConnection(databasePath);
  new MigrationRunner().apply(connection, LIFECYCLE_SCHEMA_MIGRATIONS, NOW, {
    kind: "bootstrap-empty", beforeMigration: () => undefined,
  });
  connection.exec("BEGIN IMMEDIATE");
  connection.prepare(`
    INSERT INTO project_meta(singleton, project_id, vault_id, store_id, schema_version, created_at)
    VALUES (1, $projectId, $vaultId, $storeId, 2, $createdAt)
  `).run({ $projectId: PROJECT_ID, $vaultId: VAULT_ID, $storeId: STORE_ID, $createdAt: NOW });
  connection.exec(`
    INSERT INTO maintenance_state(singleton, epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at)
    VALUES (1, 0, 'idle', NULL, 0, NULL, NULL)
  `);
  connection.exec("COMMIT");

  const ids = new DeterministicIds();
  const clock = new TestClock();
  const provider = new DeterministicCapabilityKeyProvider();
  const capabilities = new CapabilityService({ keyProvider: provider, clock, nonceSource: ids });
  const authority = new SessionAuthorityRepository();
  const leases = new SessionLeaseRepository();
  const approvals = new LifecycleApprovalRepository();
  const transfers = new ChildTransferRepository();
  const { events, store } = commandRuntime({
    connection,
    authority,
    leases,
    approvals,
    transfers,
    ids,
    clock,
    coverage,
    endingScopeProjections,
  });
  const primary = context();
  const childContext = context("child-1", "untrusted");
  const checkpointSourceCaptures = { count: 0 };
  const resumeSourceCaptures = { count: 0 };
  const processor = new LifecycleCommandProcessor({
    connection,
    commandStore: store,
    authorityRepository: authority,
    leaseRepository: leases,
    approvalRepository: approvals,
    capabilityService: capabilities,
    clock,
    identitySource: ids,
    integrity: { assertQuickHealthy: () => undefined },
    resumeSourceState: {
      captureCurrent: () => {
        resumeSourceCaptures.count += 1;
        throw new Error("unused");
      },
    },
    checkpointSourceStateProvider: {
      capture: async (projectContext: ProjectContext) => ({
        sourceStateScopeVersion: 1,
        workspaceId: projectContext.workspace.workspaceId,
        branchRef: projectContext.workspace.kind === "git" ? projectContext.workspace.branchRef : null,
        headCommit: projectContext.workspace.kind === "git" ? projectContext.workspace.headCommit : null,
        dirtyWorktreeFingerprint: "d".repeat(64),
      }),
      captureForCheckpoint: (projectContext: ProjectContext) => {
        checkpointSourceCaptures.count += 1;
        return {
          sourceStateScopeVersion: 1 as const,
          workspaceId: projectContext.workspace.workspaceId,
          branchRef: projectContext.workspace.kind === "git" ? projectContext.workspace.branchRef : null,
          headCommit: projectContext.workspace.kind === "git" ? projectContext.workspace.headCommit : null,
          dirtyWorktreeFingerprint: "d".repeat(64),
        };
      },
      captureForFinalization: (projectContext: ProjectContext) => ({
        sourceStateScopeVersion: 1,
        workspaceId: projectContext.workspace.workspaceId,
        branchRef: projectContext.workspace.kind === "git" ? projectContext.workspace.branchRef : null,
        headCommit: projectContext.workspace.kind === "git" ? projectContext.workspace.headCommit : null,
        dirtyWorktreeFingerprint: "d".repeat(64),
      }),
    },
    checkpointSourceStateScopeResolver: {
      resolve: (_current: unknown, projectContext: ProjectContext) => ({
        scopeVersion: 1,
        descriptorPath: projectContext.binding.descriptorPath,
        storeRoot: projectContext.binding.storeRoute.storeRoot,
        privateStateRoot: projectContext.binding.projectRoot,
        exactMaterializationTargets: [],
        exactCommittedTempPaths: [],
      }),
    },
  });
  const started = processor.startRoot(primary, preparedStart(primary, startCommand(100))) as RootStartSuccess;
  assert.equal(started.kind, "success");
  assert.ok(started.authorityMaterial.descriptor !== null && started.authorityMaterial.target !== null);
  const rootAuthority = capabilities.reconstructForTarget(started.authorityMaterial.descriptor, started.authorityMaterial.target);
  assert.equal(rootAuthority.kind, "root");
  const workflow = new ChildWorkflowServiceClass({
    connection,
    commandStore: store,
    authorityRepository: authority,
    capabilityService: capabilities,
    clock,
    identitySource: ids,
    childBindingFingerprint: (target: { readonly actorRole: "untrusted"; readonly clientInstanceId: string }) => target.clientInstanceId === childContext.binding.clientInstanceId
      ? TARGET_BINDING_FINGERPRINT
      : null,
  });
  const query = new LifecycleQueryService({
    connection,
    authorityRepository: authority,
    capabilityService: capabilities,
  });
  const item = {
    connection, authority, leases, approvals, transfers, events, store, processor, capabilities, provider, clock, ids,
    workflow, query, primary, childContext, root: started, rootAuthority, childAuthorities: [],
    additionalConnections: [], cleanupDirectory, checkpointSourceCaptures, resumeSourceCaptures,
  };
  fixtures.push(item);
  return item;
}

function fileFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "memory-child-workflow-"));
  return fixture(join(directory, "events.sqlite"), directory);
}

function workflowFor(
  item: Fixture,
  connection: NativeConnection,
  store: LifecycleCommandStore,
  faultInjector?: (point: "after-child-effects-before-ticket-cas") => void,
): ChildWorkflowServiceLike {
  assert.ok(ChildWorkflowServiceClass);
  return new ChildWorkflowServiceClass({
    connection,
    commandStore: store,
    authorityRepository: item.authority,
    capabilityService: item.capabilities,
    clock: item.clock,
    identitySource: item.ids,
    childBindingFingerprint: (target: { readonly actorRole: "untrusted"; readonly clientInstanceId: string }) =>
      target.clientInstanceId === item.childContext.binding.clientInstanceId
        ? TARGET_BINDING_FINGERPRINT
        : null,
    faultInjector,
  });
}

afterEach(() => {
  while (fixtures.length > 0) {
    const item = fixtures.pop()!;
    for (const childAuthority of item.childAuthorities) {
      childAuthority.handle.destroy();
      if (childAuthority.kind === "root") childAuthority.resumeToken?.destroy();
    }
    if (item.rootAuthority.kind === "root") item.rootAuthority.resumeToken?.destroy();
    item.rootAuthority.handle.destroy();
    for (const connection of item.additionalConnections) connection.close();
    item.connection.close();
    if (item.cleanupDirectory !== null) rmSync(item.cleanupDirectory, { recursive: true, force: true });
  }
});

function base(ordinal: number) {
  return {
    commandId: lifecycleUuid(ordinal),
    idempotencyKey: `child/${ordinal}`,
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
  } as const;
}

function signedGrant(item: Fixture, overrides: Partial<ChildBindingGrantV1> = {}): ChildBindingGrantV1 {
  const { mac: macOverride, ...claimOverrides } = overrides;
  const claims = {
    grantVersion: 1,
    grantId: lifecycleUuid(700),
    projectId: PROJECT_ID,
    storeId: STORE_ID,
    parentSessionId: item.root.publicResult.sessionId,
    targetActorRole: "untrusted",
    targetClientInstanceId: item.childContext.binding.clientInstanceId,
    issuedAt: NOW,
    expiresAt: new Date(Number(NOW_MS + 60_000n)).toISOString(),
    bindingFingerprint: TARGET_BINDING_FINGERPRINT,
    ...claimOverrides,
  };
  const bytes = Buffer.from(canonicalJson(claims), "utf8");
  try {
    const keyId = item.provider.currentKey({ projectId: claims.projectId, storeId: claims.storeId }, "child-binding-grant").keyId;
    const mac = item.provider.mac({
      projectId: claims.projectId,
      storeId: claims.storeId,
      purpose: "child-binding-grant",
      keyId,
      domain: CHILD_BINDING_GRANT_DOMAIN,
      bytes,
    });
    try {
      return Object.freeze({
        ...claims,
        mac: macOverride ?? Buffer.from(mac).toString("base64url"),
      }) as ChildBindingGrantV1;
    } finally {
      Buffer.from(mac).fill(0);
    }
  } finally {
    bytes.fill(0);
  }
}

function prepare<C extends Exclude<import("../src/orchestrator/lifecycle/contracts/commands.js").LifecycleSemanticCommandDraft, RootStartCommandV2>>(
  item: Fixture,
  projectContext: ProjectContext,
  command: C,
  authorization: {
    readonly authoritySessionId: string;
    readonly targetSessionId: string;
    readonly capabilityKind: "root-session-handle" | "child-session-handle";
    readonly capabilityGeneration: string;
    readonly material: RootOrChildAuthorityMaterial;
    readonly targetActorRole?: "primary" | "untrusted";
    readonly targetClientInstanceId?: string;
    readonly grant?: ChildBindingGrantV1 | null;
  },
): PreparedLifecycleWorkerCommand<C> {
  const targetActorRole = authorization.targetActorRole ?? projectContext.binding.actorRole as "primary" | "untrusted";
  const targetClientInstanceId = authorization.targetClientInstanceId ?? projectContext.binding.clientInstanceId;
  const candidateIntentHash = buildLifecycleIntentWitness(command, {
    authorizationKind: "protected",
    authorizationSessionId: authorization.authoritySessionId,
    targetSessionId: authorization.targetSessionId,
    projectId: projectContext.binding.projectId,
    vaultId: projectContext.binding.vaultId,
    storeId: projectContext.binding.storeId,
    workspaceId: projectContext.binding.workspaceId,
    clientNamespace: projectContext.binding.clientNamespace,
    capabilityKind: authorization.capabilityKind,
    capabilityGeneration: authorization.capabilityGeneration,
    presentingActorRole: projectContext.binding.actorRole,
    presentingClientInstanceId: projectContext.binding.clientInstanceId,
    targetActorRole,
    targetClientInstanceId,
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).intentHash;
  const target: SemanticCommandProofTargetV1 = {
    proofVersion: 1,
    target: "semantic-command",
    projectId: projectContext.binding.projectId,
    vaultId: projectContext.binding.vaultId,
    storeId: projectContext.binding.storeId,
    workspaceId: projectContext.binding.workspaceId,
    clientNamespace: projectContext.binding.clientNamespace,
    authoritySessionId: authorization.authoritySessionId,
    targetSessionId: authorization.targetSessionId,
    presentingActorRole: projectContext.binding.actorRole,
    presentingClientInstanceId: projectContext.binding.clientInstanceId,
    targetActorRole,
    targetClientInstanceId,
    capabilityKind: authorization.capabilityKind,
    capabilityGeneration: authorization.capabilityGeneration,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    intentHash: candidateIntentHash,
    proofNonce: lifecycleUuid(Number(command.commandId.slice(-12)) + 40_000),
  };
  const bearer = authorization.material.handle;
  return {
    command,
    candidateIntentHash,
    authorization: {
      kind: "protected",
      authoritySessionId: authorization.authoritySessionId as PreparedLifecycleWorkerCommand<C>["authorization"] extends { authoritySessionId: infer S } ? S : never,
      targetSessionId: authorization.targetSessionId as PreparedLifecycleWorkerCommand<C>["authorization"] extends { targetSessionId: infer S } ? S : never,
      proof: createCapabilityProof(bearer, target),
      approval: null,
      childBindingGrant: authorization.grant ?? null,
    },
  } as PreparedLifecycleWorkerCommand<C>;
}

function rootPrepared<C extends Exclude<import("../src/orchestrator/lifecycle/contracts/commands.js").LifecycleSemanticCommandDraft, RootStartCommandV2>>(
  item: Fixture,
  command: C,
  targetSessionId: string,
  grant: ChildBindingGrantV1 | null = null,
): PreparedLifecycleWorkerCommand<C> {
  return prepare(item, item.primary, command, {
    authoritySessionId: item.root.publicResult.sessionId,
    targetSessionId,
    capabilityKind: "root-session-handle",
    capabilityGeneration: item.root.publicResult.ownerGeneration,
    material: item.rootAuthority,
    ...(grant === null ? {} : {
      targetActorRole: "untrusted" as const,
      targetClientInstanceId: grant.targetClientInstanceId,
      grant,
    }),
  });
}

function forkCommand(item: Fixture, ordinal: number, directAccessRequested: boolean): ForkChildCommandV2 {
  const root = item.authority.get(item.connection, PROJECT_ID, item.root.publicResult.sessionId)!;
  const aggregate = item.authority.requireFoldMatch(item.connection, root);
  return {
    ...base(ordinal),
    commandType: "fork-child",
    parentSessionId: item.root.publicResult.sessionId as ForkChildCommandV2["parentSessionId"],
    expectedStreamVersion: aggregate.streamVersion.toString(),
    assignment: { assignmentId: lifecycleUuid(ordinal + 1_000), summary: `Assignment ${ordinal}`, scope: `scope/${ordinal}` },
    directAccessRequested,
  };
}

function fork(item: Fixture, ordinal: number, direct = true) {
  const command = forkCommand(item, ordinal, direct);
  const grant = direct ? signedGrant(item, { grantId: lifecycleUuid(ordinal + 2_000) }) : null;
  return item.workflow.execute(item.primary, rootPrepared(item, command, command.parentSessionId, grant));
}

function directChild(item: Fixture, ordinal: number) {
  const result = success(fork(item, ordinal, true));
  assert.ok(result.authorityMaterial.descriptor !== null && result.authorityMaterial.target !== null);
  const material = item.capabilities.reconstructForTarget(
    result.authorityMaterial.descriptor,
    result.authorityMaterial.target,
  );
  assert.equal(material.kind, "child");
  item.childAuthorities.push(material);
  return { result, material };
}

function childAggregate(item: Fixture, childSessionId: string) {
  const authority = item.authority.get(item.connection, PROJECT_ID, childSessionId);
  assert.ok(authority);
  return { authority, aggregate: item.authority.requireFoldMatch(item.connection, authority) };
}

type RequiredAmendCommand = AmendChildAssignmentCommandV2 & {
  readonly expectedAssignmentRevision: string;
  readonly reasonCode: string;
};

type RequiredReportCommand = RecordChildReportCommandV2 & {
  readonly parentSessionId: RecordChildReportCommandV2["childSessionId"];
  readonly childAuthorAgentId: string;
};

function amendCommand(
  item: Fixture,
  childSessionId: string,
  ordinal: number,
  expectedAssignmentRevision = "1",
): RequiredAmendCommand {
  const { aggregate } = childAggregate(item, childSessionId);
  assert.equal(aggregate.kind, "child");
  return {
    ...base(ordinal),
    commandType: "amend-child-assignment",
    parentSessionId: item.root.publicResult.sessionId as RequiredAmendCommand["parentSessionId"],
    childSessionId: childSessionId as RequiredAmendCommand["childSessionId"],
    expectedStreamVersion: aggregate.streamVersion.toString(),
    expectedAssignmentRevision,
    assignment: {
      assignmentId: aggregate.assignment.assignmentId,
      summary: `Amended assignment ${ordinal}`,
      scope: `scope/amended/${ordinal}`,
    },
    reasonCode: "scope-refined",
  };
}

function reportDraft(twoItems = false): ChildReportDraftV1 {
  const finding = { summary: "Finding one", evidenceReferences: ["coverage:1"], confidence: "high" as const };
  return {
    reportVersion: 1,
    outcomeSummary: "Child work is ready for primary review",
    findings: twoItems ? [finding, { ...finding, summary: "Finding two" }] : [finding],
    proposedDecisions: [],
    filesObservedOrChanged: [],
    verificationPerformed: [],
    openFollowUps: [],
    blockers: [],
    evidenceFingerprints: [{
      fingerprintSchemaVersion: 1,
      fingerprintKeyId: "test-evidence-fingerprint-key-v1",
      fingerprintDomain: "pm-evidence-frame-v1",
      fingerprint: "a".repeat(64),
    }],
  };
}

function reportCommand(
  item: Fixture,
  childSessionId: string,
  ordinal: number,
  options: { readonly primary?: boolean; readonly twoItems?: boolean } = {},
): RequiredReportCommand {
  const { aggregate } = childAggregate(item, childSessionId);
  return {
    ...base(ordinal),
    agentId: options.primary === false ? "agent-child" : "agent-primary",
    commandType: "record-child-report",
    parentSessionId: item.root.publicResult.sessionId as RequiredReportCommand["parentSessionId"],
    childSessionId: childSessionId as RequiredReportCommand["childSessionId"],
    expectedStreamVersion: aggregate.streamVersion.toString(),
    childAuthorAgentId: "agent-child",
    report: reportDraft(options.twoItems),
  };
}

function childPrepared<C extends RequiredReportCommand | ProposeChildCompletionCommandV2>(
  item: Fixture,
  command: C,
  material: RootOrChildAuthorityMaterial,
): PreparedLifecycleWorkerCommand<C> {
  const current = item.authority.get(item.connection, PROJECT_ID, command.childSessionId)!;
  assert.equal(current.childCapabilityGeneration, 1n);
  return prepare(item, item.childContext, command, {
    authoritySessionId: command.childSessionId,
    targetSessionId: command.childSessionId,
    capabilityKind: "child-session-handle",
    capabilityGeneration: current.childCapabilityGeneration.toString(),
    material,
    targetActorRole: "untrusted",
    targetClientInstanceId: item.childContext.binding.clientInstanceId,
  });
}

function reportPayloads(item: Fixture, childSessionId: string, eventType: string): readonly Record<string, unknown>[] {
  return item.connection.prepare(`
    SELECT payload_json FROM events
    WHERE project_id = $projectId AND session_id = $sessionId AND event_type = $eventType
    ORDER BY stream_version
  `).all({ $projectId: PROJECT_ID, $sessionId: childSessionId, $eventType: eventType })
    .map((row) => JSON.parse(row.payload_json as string) as Record<string, unknown>);
}

function disposition(
  reportId: string,
  itemIds: readonly string[],
  kind: ChildDispositionV1["kind"],
  supersededByReportId: string | null = null,
): ChildDispositionV1 {
  const accepted = kind === "accepted"
    ? [...itemIds]
    : kind === "partially-accepted" ? [itemIds[0]!] : [];
  const rejected = kind === "accepted"
    ? []
    : kind === "partially-accepted" ? itemIds.slice(1) : [...itemIds];
  return {
    dispositionVersion: 1,
    reportId: reportId as ChildDispositionV1["reportId"],
    kind,
    acceptedItemIds: accepted as unknown as ChildDispositionV1["acceptedItemIds"],
    rejectedItemIds: rejected as unknown as ChildDispositionV1["rejectedItemIds"],
    deferredItemIds: [],
    supersededByReportId: supersededByReportId as ChildDispositionV1["supersededByReportId"],
    explanation: `${kind} by primary`,
    allReportItemIds: [...itemIds] as unknown as ChildDispositionV1["allReportItemIds"],
  };
}

function seedSessionCheckpoint(item: Fixture, sessionId: string, ordinal: number) {
  const authority = item.authority.get(item.connection, PROJECT_ID, sessionId);
  assert.ok(authority !== null);
  const aggregate = item.authority.requireFoldMatch(item.connection, authority);
  const nextPosition = (item.connection.prepare(
    "SELECT COALESCE(MAX(global_position), 0) + 1 AS position FROM events",
  ).get()?.position) as bigint;
  type CheckpointOptions = NonNullable<Parameters<typeof checkpointFixture>[0]>;
  const childSummaries = aggregate.kind === "root"
    ? item.authority.listNonterminalChildren(item.connection, PROJECT_ID, sessionId).map((child) => {
        const childState = item.authority.requireFoldMatch(item.connection, child);
        assert.equal(childState.kind, "child");
        return {
          childSessionId: child.sessionId,
          state: childState.state,
          lastEventPosition: childState.eventPosition.toString(),
          streamVersion: childState.streamVersion.toString(),
          latestCheckpointId: childState.latestCheckpointId,
        };
      }).sort((left, right) => left.childSessionId.localeCompare(right.childSessionId))
    : [];
  const checkpoint = Object.freeze({
    ...checkpointFixture({
    sessionId: sessionId as CheckpointOptions["sessionId"],
    parentSessionId: authority.parentSessionId as CheckpointOptions["parentSessionId"],
    checkpointId: lifecycleUuid(ordinal) as CheckpointOptions["checkpointId"],
    baseEventPosition: nextPosition - 1n,
    checkpointEventPosition: nextPosition,
    }),
    childSummaries: Object.freeze(childSummaries),
  });
  const append: AppendCommand<JsonValue> = {
    context: aggregate.kind === "root" ? item.primary : item.childContext,
    commandId: lifecycleUuid(ordinal + 1),
    idempotencyKey: `seed-checkpoint/${ordinal}`,
    commandType: "seed-child-checkpoint",
    correlationId: aggregate.correlationId,
    agentId: "agent-child",
    expectedStreamVersion: aggregate.streamVersion,
    streamId: authority.streamId,
    streamType: "session",
    events: [{
      eventType: "SessionCheckpointRecorded",
      eventSchemaVersion: 1,
      occurredAt: NOW,
      visibilityScope: "session",
      sessionId,
      parentSessionId: authority.parentSessionId ?? undefined,
      confidence: "high",
      verificationStatus: "verified",
      payload: {
        checkpoint: checkpoint as unknown as JsonValue,
        baseEventPosition: checkpoint.baseEventPosition,
        checkpointEventPosition: checkpoint.checkpointEventPosition,
      },
      sourceRefs: [],
      evidenceRefs: [],
      evidenceDigests: [],
    }],
    outbox: [],
    publicResponse: { checkpointId: checkpoint.checkpointId },
  };
  const fingerprint = createHash("sha256")
    .update("project-memory/checkpoint/v1\n", "utf8")
    .update(canonicalJson(checkpoint as unknown as JsonValue), "utf8")
    .digest("hex");
  item.connection.exec("BEGIN IMMEDIATE");
  try {
    const prepared = item.events.prepare(append, NOW);
    const planned = item.events.planPrepared(prepared);
    assert.equal(planned.events[0]?.globalPosition, nextPosition);
    const committed = item.events.appendPlanned(planned);
    assert.equal(item.authority.updateCheckpointIndex(item.connection, {
      projectId: PROJECT_ID,
      sessionId,
      expectedLatestCheckpointId: authority.latestCheckpointId,
      expectedLatestCheckpointEventPosition: authority.latestCheckpointEventPosition,
      expectedLatestCheckpointFingerprint: authority.latestCheckpointFingerprint,
      checkpointId: checkpoint.checkpointId,
      checkpointEventPosition: nextPosition,
      checkpointFingerprint: fingerprint,
      updatedAt: NOW,
    }), true);
    if (authority.checkpointRequiredEventPosition !== null) {
      assert.equal(item.authority.clearCheckpointRequired(item.connection, {
        projectId: PROJECT_ID,
        sessionId,
        checkpointBaseEventPosition: nextPosition - 1n,
        updatedAt: NOW,
      }), true);
    }
    item.connection.exec("COMMIT");
  } catch (error) {
    item.connection.exec("ROLLBACK");
    throw error;
  }
  return checkpoint;
}

function seedChildCheckpoint(item: Fixture, childSessionId: string, ordinal: number) {
  const checkpoint = seedSessionCheckpoint(item, childSessionId, ordinal);
  const aggregate = item.authority.requireFoldMatch(
    item.connection,
    item.authority.get(item.connection, PROJECT_ID, childSessionId)!,
  );
  assert.equal(aggregate.kind, "child");
  return checkpoint;
}

function corruptLatestCheckpointFingerprint(item: Fixture, sessionId: string): SessionAuthorityRecord {
  const current = item.authority.get(item.connection, PROJECT_ID, sessionId);
  assert.ok(current !== null && current.latestCheckpointFingerprint !== null);
  const corruptedFingerprint = current.latestCheckpointFingerprint === "0".repeat(64)
    ? "1".repeat(64)
    : "0".repeat(64);
  const result = item.connection.prepare(`
    UPDATE session_authority
    SET latest_checkpoint_fingerprint = $fingerprint
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $projectId: PROJECT_ID,
    $sessionId: sessionId,
    $fingerprint: corruptedFingerprint,
  });
  assert.equal(result.changes, 1n);
  const corrupted = item.authority.get(item.connection, PROJECT_ID, sessionId);
  assert.ok(corrupted !== null);
  assert.equal(corrupted.latestCheckpointFingerprint, corruptedFingerprint);
  return corrupted;
}

function rootCheckpointDraft() {
  return {
    checkpointVersion: 1 as const,
    taskSummary: "Durable root suspension checkpoint",
    completedItems: [],
    inProgressItems: [],
    blockers: [],
    nextActions: [],
    decisions: [],
    assumptions: [],
    unresolvedConflicts: [],
    filesTouched: [],
    artifactReferences: [],
    sourceReferences: [],
    commandResults: [],
    testResults: [],
    materialClaims: [],
  };
}

function claimScenario(item: Fixture, ordinal: number) {
  const child = directChild(item, ordinal);
  const oldChildId = child.result.publicResult.childSessionId;
  const checkpoint = seedChildCheckpoint(item, oldChildId, ordinal + 100);
  const aggregate = childAggregate(item, oldChildId).aggregate;
  const suspend: SuspendChildSessionCommandV2 = {
    ...base(ordinal + 1),
    commandType: "suspend-child-session",
    parentSessionId: item.root.publicResult.sessionId as SuspendChildSessionCommandV2["parentSessionId"],
    childSessionId: oldChildId as SuspendChildSessionCommandV2["childSessionId"],
    expectedStreamVersion: aggregate.streamVersion.toString(),
    checkpointId: checkpoint.checkpointId,
    blockers: ["blocked for transfer"],
    followUps: ["claim from a future root"],
  };
  const suspended = success(item.workflow.execute(item.primary, rootPrepared(item, suspend, oldChildId)));
  const futureStart = item.processor.startRoot(
    item.primary,
    preparedStart(item.primary, startCommand(ordinal + 200)),
  ) as RootStartSuccess;
  assert.equal(futureStart.kind, "success");
  assert.ok(futureStart.authorityMaterial.descriptor !== null && futureStart.authorityMaterial.target !== null);
  const futureAuthority = item.capabilities.reconstructForTarget(
    futureStart.authorityMaterial.descriptor,
    futureStart.authorityMaterial.target,
  );
  item.childAuthorities.push(futureAuthority);
  seedSessionCheckpoint(item, futureStart.publicResult.sessionId, ordinal + 202);
  const futureRoot = item.authority.get(item.connection, PROJECT_ID, futureStart.publicResult.sessionId)!;
  const futureAggregate = item.authority.requireFoldMatch(item.connection, futureRoot);
  const claim: ClaimChildTransferCommandV2 = {
    ...base(ordinal + 201),
    commandType: "claim-child-transfer",
    rootSessionId: futureStart.publicResult.sessionId as ClaimChildTransferCommandV2["rootSessionId"],
    transferTicketId: suspended.publicResult.transferTicketId as ClaimChildTransferCommandV2["transferTicketId"],
    expectedStreamVersion: futureAggregate.streamVersion.toString(),
  };
  const preparedClaim = prepare(item, item.primary, claim, {
    authoritySessionId: futureStart.publicResult.sessionId,
    targetSessionId: futureStart.publicResult.sessionId,
    capabilityKind: "root-session-handle",
    capabilityGeneration: futureStart.publicResult.ownerGeneration,
    material: futureAuthority,
  });
  return { child, oldChildId, suspended, futureStart, futureAuthority, claim, preparedClaim };
}

function forkUnderRoot(
  item: Fixture,
  root: RootStartSuccess,
  rootAuthority: RootOrChildAuthorityMaterial,
  ordinal: number,
) {
  const rootRecord = item.authority.get(
    item.connection,
    PROJECT_ID,
    root.publicResult.sessionId,
  );
  assert.ok(rootRecord !== null);
  const aggregate = item.authority.requireFoldMatch(item.connection, rootRecord);
  assert.equal(aggregate.kind, "root");
  const command: ForkChildCommandV2 = {
    ...base(ordinal),
    commandType: "fork-child",
    parentSessionId: root.publicResult.sessionId as ForkChildCommandV2["parentSessionId"],
    expectedStreamVersion: aggregate.streamVersion.toString(),
    assignment: {
      assignmentId: lifecycleUuid(ordinal + 1_000),
      summary: `Destination assignment ${ordinal}`,
      scope: `scope/destination/${ordinal}`,
    },
    directAccessRequested: false,
  };
  return success(item.workflow.execute(item.primary, prepare(item, item.primary, command, {
    authoritySessionId: root.publicResult.sessionId,
    targetSessionId: root.publicResult.sessionId,
    capabilityKind: "root-session-handle",
    capabilityGeneration: root.publicResult.ownerGeneration,
    material: rootAuthority,
  })));
}

function suspendUnderRoot(
  item: Fixture,
  root: RootStartSuccess,
  rootAuthority: RootOrChildAuthorityMaterial,
  childSessionId: string,
  ordinal: number,
) {
  const checkpoint = seedChildCheckpoint(item, childSessionId, ordinal + 100);
  const aggregate = childAggregate(item, childSessionId).aggregate;
  assert.equal(aggregate.kind, "child");
  const command: SuspendChildSessionCommandV2 = {
    ...base(ordinal),
    commandType: "suspend-child-session",
    parentSessionId: root.publicResult.sessionId as SuspendChildSessionCommandV2["parentSessionId"],
    childSessionId: childSessionId as SuspendChildSessionCommandV2["childSessionId"],
    expectedStreamVersion: aggregate.streamVersion.toString(),
    checkpointId: checkpoint.checkpointId,
    blockers: ["retain this destination carry-forward ticket"],
    followUps: ["preserve it while another ticket is claimed"],
  };
  const suspended = success(item.workflow.execute(
    item.primary,
    prepare(item, item.primary, command, {
      authoritySessionId: root.publicResult.sessionId,
      targetSessionId: childSessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: root.publicResult.ownerGeneration,
      material: rootAuthority,
    }),
  ));
  return { checkpoint, suspended };
}

function capacityHarness(
  options: {
    readonly evidenceCoverage?: CheckpointEvidenceCoverageV2;
    readonly realEstimators?: boolean;
  } = {},
) {
  const checkpointInputs: MinimumCheckpointCapacityInput[] = [];
  const endingInputs: MinimumEndingScopeCapacityInput[] = [];
  const checkpointEstimates: number[] = [];
  const endingEstimates: number[] = [];
  const checkpointCoverageJson: string[] = [];
  const snapshots: {
    readonly sessionId: string;
    readonly baseEventPosition: bigint;
  }[] = [];
  let checkpointBytes = CHECKPOINT_MAX_CANONICAL_BYTES;
  let endingBytes = FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES;
  const evidenceCoverage: CheckpointEvidenceCoverageV2 =
    options.evidenceCoverage ?? Object.freeze({
    coverageVersion: 2,
    captureMode: "coverage-only",
    contentRetained: false,
    adapterSessions: Object.freeze([{
      adapterSessionId: lifecycleUuid(91_000) as CheckpointEvidenceCoverageV2["adapterSessions"][number]["adapterSessionId"],
      coverageFirstOrdinal: "0" as const,
      coverageLastOrdinal: "9223372036854775807",
      highestContiguousOrdinal: null,
      missingIntervals: Object.freeze([{
        firstOrdinal: "0",
        lastOrdinal: "9223372036854775807",
      }]),
      frameFingerprintAlgorithm: "hmac-sha256" as const,
      frameFingerprintSchemaVersion: 1 as const,
      frameFingerprintKeyId: "frame\"\\\u0001😀",
      frameFingerprintDomain: "pm-evidence-frame-v1" as const,
      coverageFingerprintAlgorithm: "hmac-sha256" as const,
      coverageFingerprintSchemaVersion: 1 as const,
      coverageFingerprintKeyId: "coverage\"\\\u0002😀",
      coverageFingerprintDomain: "pm-evidence-coverage-v1" as const,
      coverageFingerprint: "a".repeat(64),
      latestBatchId: lifecycleUuid(91_001) as CheckpointEvidenceCoverageV2["adapterSessions"][number]["latestBatchId"],
      latestBatchEventPosition: "9223372036854775807",
    }]),
  });
  const coverage = healthyCoverageFacade({
    snapshotV2: (sessionId, baseEventPosition) => {
      snapshots.push({ sessionId, baseEventPosition });
      return evidenceCoverage;
    },
    minimumCheckpointUpperBound: (input) => {
      checkpointCoverageJson.push(canonicalJson(input.evidenceCoverage));
      checkpointInputs.push(input);
      const estimate = options.realEstimators
        ? minimumCheckpointUpperBound(input)
        : checkpointBytes;
      checkpointEstimates.push(estimate);
      return estimate;
    },
    minimumFinalEndingScopeBindingsUpperBound: (input) => {
      endingInputs.push(input);
      const estimate = options.realEstimators
        ? minimumFinalEndingScopeBindingsUpperBound(input)
        : endingBytes;
      endingEstimates.push(estimate);
      return estimate;
    },
  });
  return {
    coverage,
    evidenceCoverage,
    checkpointInputs,
    endingInputs,
    checkpointEstimates,
    endingEstimates,
    checkpointCoverageJson,
    snapshots,
    resetCalls: () => {
      checkpointInputs.length = 0;
      endingInputs.length = 0;
      checkpointEstimates.length = 0;
      endingEstimates.length = 0;
      checkpointCoverageJson.length = 0;
      snapshots.length = 0;
    },
    setEstimates: (nextCheckpointBytes: number, nextEndingBytes: number) => {
      checkpointBytes = nextCheckpointBytes;
      endingBytes = nextEndingBytes;
    },
  };
}

function boundaryEvidenceCoverage(
  latestBatchEventPosition: "1" | "10",
): CheckpointEvidenceCoverageV2 {
  return Object.freeze({
    coverageVersion: 2,
    captureMode: "coverage-only",
    contentRetained: false,
    adapterSessions: Object.freeze([{
      adapterSessionId: lifecycleUuid(92_000) as CheckpointEvidenceCoverageV2["adapterSessions"][number]["adapterSessionId"],
      coverageFirstOrdinal: "0" as const,
      coverageLastOrdinal: "0",
      highestContiguousOrdinal: "0",
      missingIntervals: Object.freeze([]),
      frameFingerprintAlgorithm: "hmac-sha256" as const,
      frameFingerprintSchemaVersion: 1 as const,
      frameFingerprintKeyId: "k".repeat(45),
      frameFingerprintDomain: "pm-evidence-frame-v1" as const,
      coverageFingerprintAlgorithm: "hmac-sha256" as const,
      coverageFingerprintSchemaVersion: 1 as const,
      coverageFingerprintKeyId: "k",
      coverageFingerprintDomain: "pm-evidence-coverage-v1" as const,
      coverageFingerprint: "a".repeat(64),
      latestBatchId: lifecycleUuid(92_001) as CheckpointEvidenceCoverageV2["adapterSessions"][number]["latestBatchId"],
      latestBatchEventPosition,
    }]),
  });
}

function projectedCurrentChildren(
  projectId: string,
  rootSessionId: string,
  count: number,
): readonly CurrentChildEndingScopeProjectionRecord[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => Object.freeze({
    projectId,
    rootSessionId,
    childSessionId: lifecycleUuid(200_000 + index),
    childState: "active" as const,
    lastEventPosition: 1n,
    streamVersion: 1n,
    checkpointId: null,
    checkpointEventPosition: null,
  })));
}

function projectedCarryTickets(
  projectId: string,
  rootSessionId: string,
  count: number,
): readonly CarryForwardEndingScopeProjectionRecord[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => Object.freeze({
    projectId,
    rootSessionId,
    childSessionId: lifecycleUuid(400_000 + index),
    childState: "transferred" as const,
    lastEventPosition: 1n,
    streamVersion: 1n,
    checkpointId: lifecycleUuid(500_000 + index),
    checkpointEventPosition: 1n,
    transferTicketId: lifecycleUuid(600_000 + index),
    transferTicketEventPosition: 1n,
  })));
}

function persistentChildWorkflowCounts(item: Fixture) {
  return Object.freeze({
    events: item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
    dedup: item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
    authority: item.connection.prepare("SELECT COUNT(*) AS count FROM session_authority").get()?.count,
    tickets: item.connection.prepare("SELECT COUNT(*) AS count FROM child_transfer_tickets").get()?.count,
  });
}

function assertProspectiveReplacement(
  binding: FinalEndingScopeBindingV1 | undefined,
  excludedChildSessionId?: string,
): asserts binding is FinalEndingScopeBindingV1 {
  assert.ok(binding !== undefined);
  assert.equal(binding.bindingKind, "current-child");
  assert.equal(binding.childState, "active");
  assert.equal(binding.lastEventPosition, "9223372036854775807");
  assert.equal(binding.streamVersion, "9223372036854775807");
  assert.equal(binding.checkpointId, null);
  assert.equal(binding.checkpointEventPosition, null);
  assert.equal(binding.transferTicketId, null);
  assert.equal(binding.transferTicketEventPosition, null);
  if (excludedChildSessionId !== undefined) {
    assert.notEqual(binding.childSessionId, excludedChildSessionId);
  }
}

function success(result: WorkerLifecycleResult<ChildWorkflowResultV2>) {
  assert.equal(result.kind, "success");
  if (result.kind !== "success") assert.fail("expected child workflow success");
  return result;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof LifecycleError ? error.code : undefined;
}

describe("scoped child lifecycle", () => {
  it("rejects an exactly-full bounded ending-scope page before estimation or state growth", () => {
    for (const projectionKind of ["current-child", "carry-forward-ticket"] as const) {
      const capacity = capacityHarness();
      const requests: { readonly source: "children" | "tickets"; readonly limit: number }[] = [];
      const item = fixture(":memory:", null, capacity.coverage, {
        children: (projectId, rootSessionId, limit) => {
          requests.push({ source: "children", limit });
          return projectionKind === "current-child"
            ? projectedCurrentChildren(projectId, rootSessionId, 606).slice(0, limit)
            : [];
        },
        tickets: (projectId, rootSessionId, limit) => {
          requests.push({ source: "tickets", limit });
          return projectionKind === "carry-forward-ticket"
            ? projectedCarryTickets(projectId, rootSessionId, 606).slice(0, limit)
            : [];
        },
      });
      const beforeCounts = persistentChildWorkflowCounts(item);
      const beforeUuids = item.ids.uuidCalls;
      const beforeBytes = item.ids.bytesCalls;

      assert.throws(
        () => fork(item, 89_000 + (projectionKind === "current-child" ? 0 : 10), false),
        (error: unknown) => errorCode(error) === "CHECKPOINT_CAPACITY_EXCEEDED",
      );

      assert.deepEqual(requests, [
        { source: "children", limit: 606 },
        { source: "tickets", limit: 606 },
      ]);
      assert.equal(capacity.snapshots.length, 0);
      assert.equal(capacity.checkpointInputs.length, 0);
      assert.equal(capacity.endingInputs.length, 0);
      assert.equal(item.ids.uuidCalls, beforeUuids);
      assert.equal(item.ids.bytesCalls, beforeBytes);
      assert.deepEqual(persistentChildWorkflowCounts(item), beforeCounts);
    }
  });

  it("classifies malformed bounded ending-scope results as integrity failures", () => {
    for (const malformedSource of ["children", "tickets"] as const) {
      const capacity = capacityHarness();
      const item = fixture(":memory:", null, capacity.coverage, {
        children: () => malformedSource === "children"
          ? Object.freeze({}) as unknown as readonly CurrentChildEndingScopeProjectionRecord[]
          : [],
        tickets: () => malformedSource === "tickets"
          ? Object.freeze({}) as unknown as readonly CarryForwardEndingScopeProjectionRecord[]
          : [],
      });
      const beforeCounts = persistentChildWorkflowCounts(item);
      const beforeUuids = item.ids.uuidCalls;
      const beforeBytes = item.ids.bytesCalls;

      assert.throws(
        () => fork(item, 89_050 + (malformedSource === "children" ? 0 : 10), false),
        (error: unknown) => errorCode(error) === "INTEGRITY_FAILURE",
      );

      assert.equal(capacity.snapshots.length, 0);
      assert.equal(capacity.checkpointInputs.length, 0);
      assert.equal(capacity.endingInputs.length, 0);
      assert.equal(item.ids.uuidCalls, beforeUuids);
      assert.equal(item.ids.bytesCalls, beforeBytes);
      assert.deepEqual(persistentChildWorkflowCounts(item), beforeCounts);
    }
  });

  it("uses real estimators at independently serialized exact and plus-one checkpoint boundaries", () => {
    for (const boundary of [
      {
        latestBatchEventPosition: "1" as const,
        expectedCheckpointBytes: 262_144,
        ordinal: 89_100,
        rejected: false,
      },
      {
        latestBatchEventPosition: "10" as const,
        expectedCheckpointBytes: 262_145,
        ordinal: 89_200,
        rejected: true,
      },
    ]) {
      const evidenceCoverage = boundaryEvidenceCoverage(
        boundary.latestBatchEventPosition,
      );
      const capacity = capacityHarness({
        evidenceCoverage,
        realEstimators: true,
      });
      const requestedLimits: number[] = [];
      const item = fixture(":memory:", null, capacity.coverage, {
        children: (projectId, rootSessionId, limit) => {
          requestedLimits.push(limit);
          return projectedCurrentChildren(
            projectId,
            rootSessionId,
            579,
          ).slice(0, limit);
        },
        tickets: () => [],
      });
      const beforeCounts = persistentChildWorkflowCounts(item);
      const beforeUuids = item.ids.uuidCalls;
      const beforeBytes = item.ids.bytesCalls;

      if (boundary.rejected) {
        assert.throws(
          () => fork(item, boundary.ordinal, false),
          (error: unknown) => errorCode(error) === "CHECKPOINT_CAPACITY_EXCEEDED",
        );
      } else {
        assert.equal(
          success(fork(item, boundary.ordinal, false)).publicResult.operation,
          "fork-child",
        );
      }

      assert.deepEqual(requestedLimits, [606]);
      assert.equal(capacity.checkpointInputs.length, 1);
      assert.equal(capacity.endingInputs.length, 1);
      assert.strictEqual(
        capacity.checkpointInputs[0]?.endingScopeBindings,
        capacity.endingInputs[0]?.endingScopeBindings,
      );
      const bindings = capacity.checkpointInputs[0]!.endingScopeBindings;
      assert.equal(bindings.length, 580);
      assert.equal(
        referenceMinimumCheckpointUpperBound(evidenceCoverage, bindings),
        boundary.expectedCheckpointBytes,
      );
      assert.deepEqual(
        capacity.checkpointEstimates,
        [boundary.expectedCheckpointBytes],
      );
      assert.equal(
        referenceMinimumFinalEndingScopeBindingsUpperBound(bindings),
        251_141,
      );
      assert.deepEqual(capacity.endingEstimates, [251_141]);
      if (boundary.rejected) {
        assert.equal(item.ids.uuidCalls, beforeUuids);
        assert.equal(item.ids.bytesCalls, beforeBytes);
        assert.deepEqual(persistentChildWorkflowCounts(item), beforeCounts);
      }
    }
  });

  it("preserves a mixed nonempty destination in one canonical claim projection", () => {
    const capacity = capacityHarness({ realEstimators: true });
    const item = fixture(":memory:", null, capacity.coverage);
    const scenario = claimScenario(item, 93_000);
    const existingCurrent = forkUnderRoot(
      item,
      scenario.futureStart,
      scenario.futureAuthority,
      96_000,
    );
    const existingCarryChild = forkUnderRoot(
      item,
      scenario.futureStart,
      scenario.futureAuthority,
      96_100,
    );
    const existingCarry = suspendUnderRoot(
      item,
      scenario.futureStart,
      scenario.futureAuthority,
      existingCarryChild.publicResult.childSessionId,
      96_200,
    );
    seedSessionCheckpoint(
      item,
      scenario.futureStart.publicResult.sessionId,
      96_400,
    );

    const destinationRoot = item.authority.get(
      item.connection,
      PROJECT_ID,
      scenario.futureStart.publicResult.sessionId,
    );
    assert.ok(destinationRoot !== null);
    const destinationAggregate = item.authority.requireFoldMatch(
      item.connection,
      destinationRoot,
    );
    assert.equal(destinationAggregate.kind, "root");
    const claim: ClaimChildTransferCommandV2 = {
      ...base(96_500),
      commandType: "claim-child-transfer",
      rootSessionId: scenario.futureStart.publicResult.sessionId as ClaimChildTransferCommandV2["rootSessionId"],
      transferTicketId: scenario.suspended.publicResult.transferTicketId as ClaimChildTransferCommandV2["transferTicketId"],
      expectedStreamVersion: destinationAggregate.streamVersion.toString(),
    };
    const preparedClaim = prepare(item, item.primary, claim, {
      authoritySessionId: scenario.futureStart.publicResult.sessionId,
      targetSessionId: scenario.futureStart.publicResult.sessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: scenario.futureStart.publicResult.ownerGeneration,
      material: scenario.futureAuthority,
    });

    const currentAuthority = item.authority.get(
      item.connection,
      PROJECT_ID,
      existingCurrent.publicResult.childSessionId,
    );
    assert.ok(currentAuthority !== null);
    const currentAggregate = item.authority.requireFoldMatch(
      item.connection,
      currentAuthority,
    );
    assert.equal(currentAggregate.kind, "child");
    const carryAuthority = item.authority.get(
      item.connection,
      PROJECT_ID,
      existingCarryChild.publicResult.childSessionId,
    );
    assert.ok(carryAuthority !== null);
    const carryAggregate = item.authority.requireFoldMatch(
      item.connection,
      carryAuthority,
    );
    assert.equal(carryAggregate.kind, "child");
    const carryTicket = item.transfers.get(
      item.connection,
      PROJECT_ID,
      existingCarry.suspended.publicResult.transferTicketId!,
    );
    assert.ok(carryTicket !== null);
    assert.ok(carryAuthority.latestCheckpointId !== null);
    assert.ok(carryAuthority.latestCheckpointEventPosition !== null);
    const expectedBindings = Object.freeze(([
      {
        bindingVersion: 1,
        bindingKind: "current-child",
        childSessionId: "00000000-0000-4000-8000-000000000000" as FinalEndingScopeBindingV1["childSessionId"],
        childState: "active",
        lastEventPosition: "9223372036854775807",
        streamVersion: "9223372036854775807",
        checkpointId: null,
        checkpointEventPosition: null,
        transferTicketId: null,
        transferTicketEventPosition: null,
      },
      {
        bindingVersion: 1,
        bindingKind: "current-child",
        childSessionId: existingCurrent.publicResult.childSessionId as FinalEndingScopeBindingV1["childSessionId"],
        childState: "active",
        lastEventPosition: currentAggregate.eventPosition.toString(),
        streamVersion: currentAggregate.streamVersion.toString(),
        checkpointId: null,
        checkpointEventPosition: null,
        transferTicketId: null,
        transferTicketEventPosition: null,
      },
      {
        bindingVersion: 1,
        bindingKind: "carry-forward-ticket",
        childSessionId: existingCarryChild.publicResult.childSessionId as FinalEndingScopeBindingV1["childSessionId"],
        childState: "transferred",
        lastEventPosition: carryTicket.createdEventPosition.toString(),
        streamVersion: carryAggregate.streamVersion.toString(),
        checkpointId: carryAuthority.latestCheckpointId as FinalEndingScopeBindingV1["checkpointId"],
        checkpointEventPosition:
          carryAuthority.latestCheckpointEventPosition.toString(),
        transferTicketId: carryTicket.transferTicketId as FinalEndingScopeBindingV1["transferTicketId"],
        transferTicketEventPosition:
          carryTicket.createdEventPosition.toString(),
      },
    ] satisfies FinalEndingScopeBindingV1[]).sort((left, right) =>
      compareCanonicalUtf8(left.childSessionId, right.childSessionId)));
    const incomingTicketBefore = item.transfers.get(
      item.connection,
      PROJECT_ID,
      claim.transferTicketId,
    );
    assert.ok(incomingTicketBefore !== null);
    capacity.resetCalls();

    const claimed = success(item.workflow.execute(item.primary, preparedClaim));

    assert.equal(claimed.publicResult.operation, "claim-child-transfer");
    assert.equal(claimed.publicResult.previousChildSessionId, scenario.oldChildId);
    assert.equal(capacity.checkpointInputs.length, 1);
    assert.equal(capacity.endingInputs.length, 1);
    assert.strictEqual(
      capacity.checkpointInputs[0]?.endingScopeBindings,
      capacity.endingInputs[0]?.endingScopeBindings,
    );
    const actualBindings =
      capacity.checkpointInputs[0]!.endingScopeBindings;
    assert.deepEqual(actualBindings, expectedBindings);
    assert.equal(
      actualBindings.filter(
        (binding) => binding.childSessionId === scenario.oldChildId,
      ).length,
      0,
    );
    for (let index = 1; index < actualBindings.length; index += 1) {
      assert.equal(
        compareCanonicalUtf8(
          actualBindings[index - 1]!.childSessionId,
          actualBindings[index]!.childSessionId,
        ) < 0,
        true,
      );
    }
    const referenceCheckpointBytes = referenceMinimumCheckpointUpperBound(
      capacity.evidenceCoverage,
      expectedBindings,
    );
    const referenceEndingBytes =
      referenceMinimumFinalEndingScopeBindingsUpperBound(expectedBindings);
    assert.deepEqual(capacity.checkpointEstimates, [referenceCheckpointBytes]);
    assert.deepEqual(capacity.endingEstimates, [referenceEndingBytes]);
    assert.equal(
      referenceCheckpointBytes > referenceMinimumCheckpointUpperBound(
        capacity.evidenceCoverage,
        expectedBindings.map((binding) => ({
          bindingKind: "carry-forward-ticket" as const,
          childSessionId: binding.childSessionId,
        })),
      ),
      true,
    );
    assert.equal(
      item.transfers.get(
        item.connection,
        PROJECT_ID,
        existingCarry.suspended.publicResult.transferTicketId!,
      )?.claimedEventPosition,
      null,
    );
    assert.equal(
      item.transfers.get(
        item.connection,
        PROJECT_ID,
        claim.transferTicketId,
      )?.claimedChildSessionId,
      claimed.publicResult.childSessionId,
    );
  });

  it("rejects every state-growing path before capacity is exceeded", () => {
    const exactForkCapacity = capacityHarness();
    const exactForkItem = fixture(":memory:", null, exactForkCapacity.coverage);
    const exactFork = success(fork(exactForkItem, 90_000, false));
    assert.equal(exactFork.publicResult.operation, "fork-child");
    assert.equal(exactForkCapacity.checkpointInputs.length, 1);
    assert.equal(exactForkCapacity.endingInputs.length, 1);
    assert.strictEqual(
      exactForkCapacity.checkpointInputs[0]?.endingScopeBindings,
      exactForkCapacity.endingInputs[0]?.endingScopeBindings,
    );
    assert.equal(exactForkCapacity.checkpointCoverageJson.length, 1);
    assert.equal(exactForkCapacity.checkpointCoverageJson[0]!.includes("\\u0001"), true);
    assert.equal(exactForkCapacity.checkpointCoverageJson[0]!.includes("\\\""), true);
    assert.equal(exactForkCapacity.checkpointCoverageJson[0]!.includes("\\\\"), true);
    assert.equal(exactForkCapacity.checkpointCoverageJson[0]!.includes("😀"), true);
    assert.deepEqual(exactForkCapacity.snapshots, [{
      sessionId: exactForkItem.root.publicResult.sessionId,
      baseEventPosition: 1n,
    }]);
    assert.equal(exactForkCapacity.checkpointInputs[0]?.endingScopeBindings.length, 1);
    assertProspectiveReplacement(exactForkCapacity.checkpointInputs[0]?.endingScopeBindings[0]);

    for (const overage of ["checkpoint", "ending"] as const) {
      const capacity = capacityHarness();
      capacity.setEstimates(
        overage === "checkpoint"
          ? CHECKPOINT_MAX_CANONICAL_BYTES + 1
          : CHECKPOINT_MAX_CANONICAL_BYTES,
        overage === "ending"
          ? FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES + 1
          : FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES,
      );
      const item = fixture(":memory:", null, capacity.coverage);
      const beforeCounts = persistentChildWorkflowCounts(item);
      const beforeUuids = item.ids.uuidCalls;
      const beforeBytes = item.ids.bytesCalls;
      assert.throws(
        () => fork(item, 90_100 + (overage === "checkpoint" ? 0 : 10), true),
        (error: unknown) => errorCode(error) === "CHECKPOINT_CAPACITY_EXCEEDED",
      );
      assert.equal(capacity.checkpointInputs.length, 1);
      assert.equal(capacity.endingInputs.length, 1);
      assert.strictEqual(
        capacity.checkpointInputs[0]?.endingScopeBindings,
        capacity.endingInputs[0]?.endingScopeBindings,
      );
      assert.equal(item.ids.uuidCalls, beforeUuids);
      assert.equal(item.ids.bytesCalls, beforeBytes);
      assert.deepEqual(persistentChildWorkflowCounts(item), beforeCounts);
    }

    const exactClaimCapacity = capacityHarness();
    const exactClaimItem = fixture(":memory:", null, exactClaimCapacity.coverage);
    const exactClaimScenario = claimScenario(exactClaimItem, 90_200);
    exactClaimCapacity.resetCalls();
    const exactClaim = success(exactClaimItem.workflow.execute(
      exactClaimItem.primary,
      exactClaimScenario.preparedClaim,
    ));
    assert.equal(exactClaim.publicResult.operation, "claim-child-transfer");
    assert.equal(exactClaimCapacity.checkpointInputs.length, 1);
    assert.equal(exactClaimCapacity.endingInputs.length, 1);
    assert.strictEqual(
      exactClaimCapacity.checkpointInputs[0]?.endingScopeBindings,
      exactClaimCapacity.endingInputs[0]?.endingScopeBindings,
    );
    assert.equal(exactClaimCapacity.checkpointInputs[0]?.endingScopeBindings.length, 1);
    assertProspectiveReplacement(
      exactClaimCapacity.checkpointInputs[0]?.endingScopeBindings[0],
      exactClaimScenario.oldChildId,
    );

    for (const overage of ["checkpoint", "ending"] as const) {
      const capacity = capacityHarness();
      const item = fixture(":memory:", null, capacity.coverage);
      const scenario = claimScenario(
        item,
        90_500 + (overage === "checkpoint" ? 0 : 300),
      );
      capacity.resetCalls();
      capacity.setEstimates(
        overage === "checkpoint"
          ? CHECKPOINT_MAX_CANONICAL_BYTES + 1
          : CHECKPOINT_MAX_CANONICAL_BYTES,
        overage === "ending"
          ? FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES + 1
          : FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES,
      );
      const beforeCounts = persistentChildWorkflowCounts(item);
      const beforeUuids = item.ids.uuidCalls;
      const ticketBefore = item.transfers.get(
        item.connection,
        PROJECT_ID,
        scenario.suspended.publicResult.transferTicketId!,
      );
      assert.ok(ticketBefore !== null);
      assert.throws(
        () => item.workflow.execute(item.primary, scenario.preparedClaim),
        (error: unknown) => errorCode(error) === "CHECKPOINT_CAPACITY_EXCEEDED",
      );
      assert.equal(capacity.checkpointInputs.length, 1);
      assert.equal(capacity.endingInputs.length, 1);
      assert.strictEqual(
        capacity.checkpointInputs[0]?.endingScopeBindings,
        capacity.endingInputs[0]?.endingScopeBindings,
      );
      assert.equal(capacity.checkpointInputs[0]?.endingScopeBindings.length, 1);
      assertProspectiveReplacement(
        capacity.checkpointInputs[0]?.endingScopeBindings[0],
        scenario.oldChildId,
      );
      assert.equal(item.ids.uuidCalls, beforeUuids);
      assert.deepEqual(persistentChildWorkflowCounts(item), beforeCounts);
      assert.deepEqual(item.transfers.get(
        item.connection,
        PROJECT_ID,
        scenario.suspended.publicResult.transferTicketId!,
      ), ticketBefore);
    }
  });

  it("forks one immutable child stream without changing root authority or lease", () => {
    const item = fixture();
    const rootBefore = item.authority.get(item.connection, PROJECT_ID, item.root.publicResult.sessionId)!;
    const leaseBefore = item.leases.current(item.connection, PROJECT_ID, item.root.publicResult.sessionId)!;
    const noGrant = success(fork(item, 1_000, false));
    assert.equal(noGrant.publicResult.operation, "fork-child");
    assert.equal(noGrant.publicResult.directAccessEnabled, false);
    const direct = success(fork(item, 1_001, true));
    assert.equal(direct.publicResult.directAccessEnabled, true);
    assert.equal(direct.publicResult.rootOwnerGeneration, "1");
    assert.equal(direct.authorityMaterial.target?.actorRole, "untrusted");
    assert.equal(direct.authorityMaterial.target?.clientInstanceId, item.childContext.binding.clientInstanceId);
    assert.equal(direct.authorityMaterial.descriptor?.materials.length, 1);
    assert.equal(direct.authorityMaterial.descriptor?.materials[0]?.claims.kind, "child-session-handle");

    const child = item.authority.get(item.connection, PROJECT_ID, direct.publicResult.childSessionId)!;
    const folded = item.authority.requireFoldMatch(item.connection, child);
    assert.equal(folded.kind, "child");
    assert.equal(folded.streamVersion, 1n);
    assert.equal(folded.parentSessionId, item.root.publicResult.sessionId);
    assert.equal(folded.correlationId, item.authority.requireFoldMatch(item.connection, rootBefore).correlationId);
    assert.deepEqual(folded.assignment, direct.publicResult.assignment);
    assert.equal(folded.rootOwnerGeneration, 1);
    assert.deepEqual(item.authority.get(item.connection, PROJECT_ID, rootBefore.sessionId), rootBefore);
    assert.deepEqual(item.leases.current(item.connection, PROJECT_ID, rootBefore.sessionId), leaseBefore);

    const replay = success(item.workflow.execute(
      item.primary,
      rootPrepared(item, forkCommand(item, 1_001, true), item.root.publicResult.sessionId, signedGrant(item, { grantId: lifecycleUuid(3_001) })),
    ));
    assert.equal(replay.publicResult.childSessionId, direct.publicResult.childSessionId);
    assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'SessionForked'").get()?.count, 2n);
  });

  it("rejects root suspension before source capture when a nonterminal child checkpoint fingerprint is corrupt", () => {
    const item = fixture();
    const child = directChild(item, 1_020);
    seedChildCheckpoint(item, child.result.publicResult.childSessionId, 1_120);
    const corruptedChild = corruptLatestCheckpointFingerprint(item, child.result.publicResult.childSessionId);
    const rootBefore = item.authority.get(item.connection, PROJECT_ID, item.root.publicResult.sessionId);
    const leaseBefore = item.leases.current(item.connection, PROJECT_ID, item.root.publicResult.sessionId);
    assert.ok(rootBefore !== null && leaseBefore !== null);
    const rootAggregate = item.authority.requireFoldMatch(item.connection, rootBefore);
    const command: RootSuspendCommandV2 = {
      ...base(1_021),
      commandType: "root-suspend",
      sessionId: rootBefore.sessionId as RootSuspendCommandV2["sessionId"],
      expectedStreamVersion: rootAggregate.streamVersion.toString(),
      checkpoint: rootCheckpointDraft(),
    };
    const prepared = prepare(item, item.primary, command, {
      authoritySessionId: rootBefore.sessionId,
      targetSessionId: rootBefore.sessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: item.root.publicResult.ownerGeneration,
      material: item.rootAuthority,
    });
    const effectsBefore = {
      events: item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
      dedup: item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
      authority: item.connection.prepare("SELECT COUNT(*) AS count FROM session_authority").get()?.count,
    };

    assert.throws(
      () => item.processor.suspendRoot(item.primary, prepared),
      (error: unknown) => errorCode(error) === "INTEGRITY_FAILURE",
    );
    assert.equal(item.checkpointSourceCaptures.count, 0);
    assert.deepEqual(item.authority.get(item.connection, PROJECT_ID, rootBefore.sessionId), rootBefore);
    assert.deepEqual(item.authority.get(item.connection, PROJECT_ID, corruptedChild.sessionId), corruptedChild);
    assert.deepEqual(item.leases.current(item.connection, PROJECT_ID, rootBefore.sessionId), leaseBefore);
    assert.deepEqual({
      events: item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
      dedup: item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
      authority: item.connection.prepare("SELECT COUNT(*) AS count FROM session_authority").get()?.count,
    }, effectsBefore);
  });

  it("rejects ownership transfer when a nonterminal child's latest checkpoint fingerprint is corrupt", () => {
    const item = fixture();
    const child = directChild(item, 1_030);
    const childSessionId = child.result.publicResult.childSessionId;
    const childCheckpoint = seedChildCheckpoint(item, childSessionId, 1_130);
    const validChild = item.authority.get(item.connection, PROJECT_ID, childSessionId);
    assert.ok(validChild !== null);
    assert.equal(
      item.authority.latestCheckpoint(item.connection, validChild)?.checkpointId,
      childCheckpoint.checkpointId,
    );
    seedSessionCheckpoint(item, item.root.publicResult.sessionId, 1_131);
    const corruptedChild = corruptLatestCheckpointFingerprint(item, childSessionId);
    const childAggregateAfterCorruption = item.authority.requireFoldMatch(item.connection, corruptedChild);
    assert.equal(childAggregateAfterCorruption.kind, "child");
    assert.equal(childAggregateAfterCorruption.state, "active");

    const rootBefore = item.authority.get(item.connection, PROJECT_ID, item.root.publicResult.sessionId);
    const leaseBefore = item.leases.current(item.connection, PROJECT_ID, item.root.publicResult.sessionId);
    assert.ok(rootBefore !== null && leaseBefore !== null);
    const effectsBefore = {
      events: item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
      dedup: item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
      authority: item.connection.prepare("SELECT COUNT(*) AS count FROM session_authority").get()?.count,
      leases: item.connection.prepare("SELECT COUNT(*) AS count FROM session_leases").get()?.count,
      approvalConsumptions: item.connection.prepare(
        "SELECT COUNT(*) AS count FROM lifecycle_approval_consumptions",
      ).get()?.count,
    };
    item.clock.now = leaseBefore.expiresAtMs;
    const rotatedContext = context("primary-corrupt-child-transfer");
    const prepared = preparedResume(item, rotatedContext, resumeCommand(item, 1_031));

    assert.throws(
      () => item.processor.resumeRoot(rotatedContext, prepared),
      (error: unknown) => errorCode(error) === "INTEGRITY_FAILURE",
    );
    assert.equal(item.resumeSourceCaptures.count, 0);
    assert.equal(item.checkpointSourceCaptures.count, 0);
    assert.deepEqual(item.authority.get(item.connection, PROJECT_ID, rootBefore.sessionId), rootBefore);
    assert.deepEqual(item.authority.get(item.connection, PROJECT_ID, corruptedChild.sessionId), corruptedChild);
    assert.deepEqual(item.leases.current(item.connection, PROJECT_ID, rootBefore.sessionId), leaseBefore);
    assert.deepEqual({
      events: item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
      dedup: item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
      authority: item.connection.prepare("SELECT COUNT(*) AS count FROM session_authority").get()?.count,
      leases: item.connection.prepare("SELECT COUNT(*) AS count FROM session_leases").get()?.count,
      approvalConsumptions: item.connection.prepare(
        "SELECT COUNT(*) AS count FROM lifecycle_approval_consumptions",
      ).get()?.count,
    }, effectsBefore);
  });

  it("keeps an exact direct-fork replay stale after the parent owner generation rotates", () => {
    const item = fixture();
    const command = forkCommand(item, 1_100, true);
    const preparedFork = rootPrepared(
      item,
      command,
      command.parentSessionId,
      signedGrant(item, { grantId: lifecycleUuid(3_100) }),
    );
    const forked = success(item.workflow.execute(item.primary, preparedFork));
    assert.equal(forked.authorityMaterial.status, "current");
    assert.ok(forked.authorityMaterial.descriptor !== null);

    const generationOne = item.leases.current(
      item.connection,
      PROJECT_ID,
      item.root.publicResult.sessionId,
    );
    assert.ok(generationOne !== null);
    seedSessionCheckpoint(item, item.root.publicResult.sessionId, 1_102);
    item.clock.now = generationOne.expiresAtMs;
    const rotatedContext = context("primary-rotated");
    const rotated = item.processor.resumeRoot(
      rotatedContext,
      preparedResume(item, rotatedContext, resumeCommand(item, 1_101)),
    );
    assert.equal(rotated.kind, "success");
    if (rotated.kind !== "success") assert.fail("expected owner generation rotation");
    assert.equal(rotated.publicResult.ownerGeneration, "2");
    assert.equal(childAggregate(item, forked.publicResult.childSessionId).aggregate.kind, "child");

    const replay = success(item.workflow.execute(item.primary, preparedFork));
    assert.deepEqual(replay.publicResult, forked.publicResult);
    assert.equal(replay.authorityMaterial.status, "stale");
    assert.equal(replay.authorityMaterial.descriptor, null);
  });

  it("rejects expired, wrong-project, wrong-binding, and model-supplied grants", () => {
    const cases: readonly Partial<ChildBindingGrantV1>[] = [
      { expiresAt: NOW },
      { projectId: lifecycleUuid(8_001) },
      { bindingFingerprint: "a".repeat(64) },
      { targetClientInstanceId: "other-child" },
      { mac: "not-a-mac" },
    ];
    for (const [index, override] of cases.entries()) {
      const item = fixture();
      const command = forkCommand(item, 2_000 + index, true);
      assert.throws(
        () => item.workflow.execute(item.primary, rootPrepared(item, command, command.parentSessionId, signedGrant(item, override))),
        (error) => errorCode(error) === "SESSION_CAPABILITY_INVALID" || errorCode(error) === "SESSION_CAPABILITY_EXPIRED",
      );
    }
    const item = fixture();
    assert.throws(() => item.workflow.execute(item.primary, {
      command: { ...forkCommand(item, 2_100, true), childBindingGrant: signedGrant(item) },
      candidateIntentHash: "a".repeat(64),
      authorization: rootPrepared(item, forkCommand(item, 2_101, false), item.root.publicResult.sessionId).authorization,
    } as unknown as PreparedLifecycleWorkerCommand<ForkChildCommandV2>), /LIFECYCLE_INPUT_INVALID|SESSION_CAPABILITY_INVALID/);
  });

  it("amends assignment by explicit revision while preserving lineage, history, and retry IDs", () => {
    const item = fixture();
    const child = directChild(item, 3_000);
    const childId = child.result.publicResult.childSessionId;
    const command = amendCommand(item, childId, 3_001);
    const amended = success(item.workflow.execute(
      item.primary,
      rootPrepared(item, command, childId),
    ));
    assert.equal(amended.publicResult.assignmentRevision, "2");
    assert.deepEqual(amended.publicResult.assignment, command.assignment);
    const replay = success(item.workflow.execute(item.primary, rootPrepared(item, command, childId)));
    assert.deepEqual(replay.publicResult, amended.publicResult);
    const history = reportPayloads(item, childId, "ChildAssignmentAmended");
    assert.equal(history.length, 1);
    assert.deepEqual(history[0]?.assignment, command.assignment);
    const folded = childAggregate(item, childId).aggregate;
    assert.equal(folded.kind, "child");
    assert.equal(folded.parentSessionId, item.root.publicResult.sessionId);
    assert.equal(folded.assignmentRevision, 2);
    assert.equal(folded.assignment.assignmentId, child.result.publicResult.assignment?.assignmentId);

    const stale = amendCommand(item, childId, 3_002, "1");
    assert.throws(
      () => item.workflow.execute(item.primary, rootPrepared(item, stale, childId)),
      (error) => errorCode(error) === "EVENT_CONFLICT",
    );
    assert.throws(
      () => item.workflow.execute(item.childContext, prepare(item, item.childContext, amendCommand(item, childId, 3_003, "2"), {
        authoritySessionId: childId,
        targetSessionId: childId,
        capabilityKind: "child-session-handle",
        capabilityGeneration: "1",
        material: child.material,
        targetActorRole: "untrusted",
        targetClientInstanceId: item.childContext.binding.clientInstanceId,
      })),
      (error) => errorCode(error) === "SESSION_CAPABILITY_INVALID"
        || errorCode(error) === "SESSION_OWNERSHIP_MISMATCH"
        || (error instanceof Error && error.name === "LifecycleIntentWitnessError"),
    );
  });

  it("records direct and primary reports with generated IDs and immutable separate provenance", () => {
    const item = fixture();
    const child = directChild(item, 4_000);
    const childId = child.result.publicResult.childSessionId;
    const directCommand = reportCommand(item, childId, 4_001, { primary: false, twoItems: true });
    const direct = success(item.workflow.execute(
      item.childContext,
      childPrepared(item, directCommand, child.material),
    ));
    assert.match(direct.publicResult.reportId!, /^[0-9a-f-]{36}$/u);
    assert.equal(direct.publicResult.reportItemIds?.length, 2);
    assert.equal(new Set(direct.publicResult.reportItemIds).size, 2);
    const directReplay = success(item.workflow.execute(
      item.childContext,
      childPrepared(item, directCommand, child.material),
    ));
    assert.deepEqual(directReplay.publicResult, direct.publicResult);

    const primaryCommand = reportCommand(item, childId, 4_002, { primary: true });
    const primary = success(item.workflow.execute(
      item.primary,
      rootPrepared(item, primaryCommand, childId),
    ));
    assert.notEqual(primary.publicResult.reportId, direct.publicResult.reportId);
    const reports = reportPayloads(item, childId, "ChildWorkReported");
    assert.equal(reports.length, 2);
    assert.equal(reports[0]?.childAuthorAgentId, "agent-child");
    assert.equal(reports[0]?.primaryRecorderAgentId, null);
    assert.equal(reports[1]?.childAuthorAgentId, "agent-child");
    assert.equal(reports[1]?.primaryRecorderAgentId, "agent-primary");
    assert.equal((reports[0]?.report as Record<string, unknown>).assignmentId, child.result.publicResult.assignment?.assignmentId);

    const forgedAuthor = {
      ...reportCommand(item, childId, 4_003, { primary: false }),
      childAuthorAgentId: "different-agent",
    };
    assert.throws(
      () => item.workflow.execute(item.childContext, childPrepared(item, forgedAuthor, child.material)),
      (error) => errorCode(error) === "SESSION_OWNERSHIP_MISMATCH"
        || errorCode(error) === "SESSION_CAPABILITY_INVALID",
    );

    const other = directChild(item, 4_100);
    const crossChild = reportCommand(item, other.result.publicResult.childSessionId, 4_101, { primary: false });
    assert.throws(
      () => item.workflow.execute(item.childContext, childPrepared(item, crossChild, child.material)),
      (error) => errorCode(error) === "SESSION_CAPABILITY_INVALID"
        || errorCode(error) === "SESSION_OWNERSHIP_MISMATCH",
    );
  });

  it("retains disposition history, validates partitions, and marks the root checkpoint-required", () => {
    const item = fixture();
    const child = directChild(item, 5_000);
    const childId = child.result.publicResult.childSessionId;
    const record = (ordinal: number, twoItems = true) => {
      const command = reportCommand(item, childId, ordinal, { primary: false, twoItems });
      return success(item.workflow.execute(item.childContext, childPrepared(item, command, child.material))).publicResult;
    };
    const decide = (ordinal: number, value: ChildDispositionV1) => {
      const aggregate = childAggregate(item, childId).aggregate;
      const command: DispositionChildReportCommandV2 = {
        ...base(ordinal),
        commandType: "disposition-child-report",
        parentSessionId: item.root.publicResult.sessionId as DispositionChildReportCommandV2["parentSessionId"],
        childSessionId: childId as DispositionChildReportCommandV2["childSessionId"],
        expectedStreamVersion: aggregate.streamVersion.toString(),
        disposition: value,
      };
      return success(item.workflow.execute(item.primary, rootPrepared(item, command, childId)));
    };

    const accepted = record(5_001);
    decide(5_002, disposition(accepted.reportId!, accepted.reportItemIds!, "accepted"));
    let root = item.authority.get(item.connection, PROJECT_ID, item.root.publicResult.sessionId)!;
    assert.equal(root.checkpointRequiredReason, "accepted-child-report");
    assert.ok(root.checkpointRequiredEventPosition !== null);
    const acceptedIntegrity = new EventIntegrityService(
      item.connection,
      LIFECYCLE_SCHEMA_MIGRATIONS,
      [new LifecycleIntegrityService(item.connection)],
    ).fullCheck(item.primary);
    assert.throws(
      () => decide(5_011, disposition(accepted.reportId!, accepted.reportItemIds!, "accepted")),
      (error) => errorCode(error) === "CHILD_DISPOSITION_INVALID",
    );

    const partial = record(5_003);
    decide(5_004, disposition(partial.reportId!, partial.reportItemIds!, "partially-accepted"));
    root = item.authority.get(item.connection, PROJECT_ID, item.root.publicResult.sessionId)!;
    assert.equal(root.checkpointRequiredReason, "accepted-child-report");
    const partialIntegrity = new EventIntegrityService(
      item.connection,
      LIFECYCLE_SCHEMA_MIGRATIONS,
      [new LifecycleIntegrityService(item.connection)],
    ).fullCheck(item.primary);
    assert.deepEqual(
      {
        accepted: acceptedIntegrity.issues.some((issue) => issue.code === "SESSION_AUTHORITY_FOLD_MISMATCH"),
        partial: partialIntegrity.issues.some((issue) => issue.code === "SESSION_AUTHORITY_FOLD_MISMATCH"),
      },
      { accepted: false, partial: false },
      JSON.stringify({ accepted: acceptedIntegrity.issues, partial: partialIntegrity.issues }),
    );

    const rejected = record(5_005);
    const proposal: ProposeChildCompletionCommandV2 = {
      ...base(5_006),
      commandType: "propose-child-completion",
      childSessionId: childId as ProposeChildCompletionCommandV2["childSessionId"],
      expectedStreamVersion: childAggregate(item, childId).aggregate.streamVersion.toString(),
      reportId: rejected.reportId as ProposeChildCompletionCommandV2["reportId"],
    };
    success(item.workflow.execute(item.childContext, childPrepared(item, proposal, child.material)));
    const rejectedResult = decide(5_007, disposition(rejected.reportId!, rejected.reportItemIds!, "rejected"));
    assert.equal(rejectedResult.publicResult.state, "active");
    const reproposal: ProposeChildCompletionCommandV2 = {
      ...base(5_014),
      commandType: "propose-child-completion",
      childSessionId: childId as ProposeChildCompletionCommandV2["childSessionId"],
      expectedStreamVersion: childAggregate(item, childId).aggregate.streamVersion.toString(),
      reportId: rejected.reportId as ProposeChildCompletionCommandV2["reportId"],
    };
    success(item.workflow.execute(item.childContext, childPrepared(item, reproposal, child.material)));
    assert.throws(
      () => decide(5_012, disposition(
        rejected.reportId!,
        rejected.reportItemIds!,
        "superseded",
        accepted.reportId!,
      )),
      (error) => errorCode(error) === "CHILD_DISPOSITION_INVALID",
    );

    const newer = record(5_008);
    const supersededResult = decide(5_009, disposition(
      rejected.reportId!,
      rejected.reportItemIds!,
      "superseded",
      newer.reportId!,
    ));
    assert.equal(supersededResult.publicResult.state, "active");
    assert.equal(reportPayloads(item, childId, "ChildWorkDispositioned").length, 4);
    assert.throws(
      () => decide(5_013, disposition(
        rejected.reportId!,
        rejected.reportItemIds!,
        "superseded",
        newer.reportId!,
      )),
      (error) => errorCode(error) === "CHILD_DISPOSITION_INVALID",
    );

    const invalid = disposition(newer.reportId!, newer.reportItemIds!, "accepted") as unknown as Record<string, unknown>;
    invalid.rejectedItemIds = [newer.reportItemIds?.[0]];
    assert.throws(
      () => decide(5_010, invalid as unknown as ChildDispositionV1),
      /CHILD_DISPOSITION_INVALID|LIFECYCLE_INTENT_WITNESS_INVALID/,
    );

    const moreWork = record(5_015);
    const moreWorkProposal: ProposeChildCompletionCommandV2 = {
      ...base(5_016),
      commandType: "propose-child-completion",
      childSessionId: childId as ProposeChildCompletionCommandV2["childSessionId"],
      expectedStreamVersion: childAggregate(item, childId).aggregate.streamVersion.toString(),
      reportId: moreWork.reportId as ProposeChildCompletionCommandV2["reportId"],
    };
    success(item.workflow.execute(item.childContext, childPrepared(item, moreWorkProposal, child.material)));
    const moreWorkResult = decide(
      5_017,
      disposition(moreWork.reportId!, moreWork.reportItemIds!, "partially-accepted"),
    );
    assert.equal(moreWorkResult.publicResult.state, "active");
  });

  it("keeps completion proposal scoped to the child and lets only the root accept terminal completion", () => {
    const item = fixture();
    const child = directChild(item, 6_000);
    const childId = child.result.publicResult.childSessionId;
    const reportCommandValue = reportCommand(item, childId, 6_001, { primary: false });
    const report = success(item.workflow.execute(
      item.childContext,
      childPrepared(item, reportCommandValue, child.material),
    )).publicResult;
    const proposal: ProposeChildCompletionCommandV2 = {
      ...base(6_002),
      commandType: "propose-child-completion",
      childSessionId: childId as ProposeChildCompletionCommandV2["childSessionId"],
      expectedStreamVersion: childAggregate(item, childId).aggregate.streamVersion.toString(),
      reportId: report.reportId as ProposeChildCompletionCommandV2["reportId"],
    };
    const proposed = success(item.workflow.execute(
      item.childContext,
      childPrepared(item, proposal, child.material),
    ));
    assert.equal(proposed.publicResult.state, "completion-proposed");
    const rootBefore = item.authority.get(item.connection, PROJECT_ID, item.root.publicResult.sessionId)!;
    assert.equal(rootBefore.semanticState, "active");
    assert.equal(rootBefore.ownerGeneration, 1n);

    const complete: CompleteChildSessionCommandV2 = {
      ...base(6_003),
      commandType: "complete-child-session",
      parentSessionId: item.root.publicResult.sessionId as CompleteChildSessionCommandV2["parentSessionId"],
      childSessionId: childId as CompleteChildSessionCommandV2["childSessionId"],
      expectedStreamVersion: childAggregate(item, childId).aggregate.streamVersion.toString(),
      reportId: report.reportId as CompleteChildSessionCommandV2["reportId"],
    };
    assert.throws(
      () => item.workflow.execute(item.childContext, prepare(item, item.childContext, complete, {
        authoritySessionId: childId,
        targetSessionId: childId,
        capabilityKind: "child-session-handle",
        capabilityGeneration: "1",
        material: child.material,
        targetActorRole: "untrusted",
        targetClientInstanceId: item.childContext.binding.clientInstanceId,
      })),
      (error) => errorCode(error) === "SESSION_CAPABILITY_INVALID"
        || errorCode(error) === "SESSION_OWNERSHIP_MISMATCH"
        || (error instanceof Error && error.name === "LifecycleIntentWitnessError"),
    );
    const completed = success(item.workflow.execute(item.primary, rootPrepared(item, complete, childId)));
    assert.equal(completed.publicResult.state, "completed");
    const completedAuthority = item.authority.get(item.connection, PROJECT_ID, childId)!;
    assert.equal(completedAuthority.semanticState, "completed");
    assert.equal(completedAuthority.terminalEventType, "ChildSessionCompleted");
    assert.equal(completedAuthority.revocationReasonCode, "child-completed");
    const completionIntegrity = new EventIntegrityService(
      item.connection,
      LIFECYCLE_SCHEMA_MIGRATIONS,
      [new LifecycleIntegrityService(item.connection)],
    );
    const completionReport = completionIntegrity.fullCheck(item.primary);
    assert.equal(
      completionReport.issues.some((issue) => issue.code === "SESSION_AUTHORITY_FOLD_MISMATCH"),
      false,
      JSON.stringify(completionReport.issues),
    );
    assert.equal(
      completionReport.issues.some((issue) => issue.code === "COMMAND_HASH_MISMATCH"
        || issue.code === "COMMAND_METADATA_MISMATCH"),
      false,
      JSON.stringify(completionReport.issues),
    );
    const replayedFork = success(fork(item, 6_000, true));
    assert.equal(replayedFork.publicResult.childSessionId, childId);
    assert.equal(replayedFork.authorityMaterial.status, "stale");
    assert.equal(replayedFork.authorityMaterial.descriptor, null);
    assert.equal(item.authority.get(item.connection, PROJECT_ID, rootBefore.sessionId)?.ownerGeneration, 1n);
    assert.throws(
      () => item.workflow.execute(item.childContext, childPrepared(item, reportCommand(item, childId, 6_004, { primary: false }), child.material)),
      (error) => errorCode(error) === "SESSION_HANDLE_STALE" || errorCode(error) === "SESSION_STATE_CONFLICT",
    );
    assert.throws(
      () => item.workflow.execute(item.primary, rootPrepared(item, amendCommand(item, childId, 6_005), childId)),
      (error) => errorCode(error) === "SESSION_STATE_CONFLICT",
    );
  });

  it("rejects transfer when relevant child work follows the cited checkpoint", () => {
    const item = fixture();
    const child = directChild(item, 6_500);
    const childId = child.result.publicResult.childSessionId;
    const checkpoint = seedChildCheckpoint(item, childId, 6_600);
    const report = reportCommand(item, childId, 6_501, { primary: false });
    success(item.workflow.execute(item.childContext, childPrepared(item, report, child.material)));
    const aggregate = childAggregate(item, childId).aggregate;
    const suspend: SuspendChildSessionCommandV2 = {
      ...base(6_502),
      commandType: "suspend-child-session",
      parentSessionId: item.root.publicResult.sessionId as SuspendChildSessionCommandV2["parentSessionId"],
      childSessionId: childId as SuspendChildSessionCommandV2["childSessionId"],
      expectedStreamVersion: aggregate.streamVersion.toString(),
      checkpointId: checkpoint.checkpointId,
      blockers: ["checkpoint is stale"],
      followUps: ["record a fresh checkpoint"],
    };
    assert.throws(
      () => item.workflow.execute(item.primary, rootPrepared(item, suspend, childId)),
      (error) => errorCode(error) === "CHECKPOINT_BASE_INVALID",
    );
  });

  it("atomically suspends with an explicit blocker-bearing ticket and claims it once into new lineage", () => {
    const item = fixture();
    const child = directChild(item, 7_000);
    const oldChildId = child.result.publicResult.childSessionId;
    const checkpoint = seedChildCheckpoint(item, oldChildId, 7_100);
    const preTicketStart = item.processor.startRoot(
      item.primary,
      preparedStart(item.primary, startCommand(7_150)),
    ) as RootStartSuccess;
    assert.equal(preTicketStart.kind, "success");
    assert.ok(preTicketStart.authorityMaterial.descriptor !== null && preTicketStart.authorityMaterial.target !== null);
    const preTicketAuthority = item.capabilities.reconstructForTarget(
      preTicketStart.authorityMaterial.descriptor,
      preTicketStart.authorityMaterial.target,
    );
    item.childAuthorities.push(preTicketAuthority);
    const before = childAggregate(item, oldChildId).aggregate;
    const suspend: SuspendChildSessionCommandV2 = {
      ...base(7_001),
      commandType: "suspend-child-session",
      parentSessionId: item.root.publicResult.sessionId as SuspendChildSessionCommandV2["parentSessionId"],
      childSessionId: oldChildId as SuspendChildSessionCommandV2["childSessionId"],
      expectedStreamVersion: before.streamVersion.toString(),
      checkpointId: checkpoint.checkpointId,
      blockers: ["blocked on a future root"],
      followUps: ["resume the scoped assignment"],
    };
    const suspended = success(item.workflow.execute(item.primary, rootPrepared(item, suspend, oldChildId)));
    assert.equal(suspended.publicResult.state, "transferred");
    assert.ok(suspended.publicResult.transferTicketId);
    const ticket = item.transfers.get(item.connection, PROJECT_ID, suspended.publicResult.transferTicketId!);
    assert.ok(ticket);
    assert.deepEqual((ticket as typeof ticket & { blockers: readonly string[] }).blockers, suspend.blockers);
    assert.deepEqual(ticket.followUps, suspend.followUps);
    assert.equal(ticket.checkpointId, checkpoint.checkpointId);
    assert.deepEqual(ticket.sourceState, checkpoint.sourceState);
    assert.equal(ticket.sourceParentSessionId, item.root.publicResult.sessionId);
    assert.equal(ticket.sourceChildSessionId, oldChildId);
    const transferredAuthority = childAggregate(item, oldChildId).authority;
    assert.equal(transferredAuthority.revocationReasonCode, "child-transferred");
    assert.equal(transferredAuthority.checkpointRequiredReason, null);
    assert.equal(transferredAuthority.checkpointRequiredEventPosition, null);
    assert.deepEqual(
      reportPayloads(item, oldChildId, "ChildSessionSuspended").map((payload) => payload.blockers),
      [suspend.blockers],
    );
    assert.equal(reportPayloads(item, oldChildId, "ChildWorkTransferCreated").length, 1);
    const suspensionIntegrity = new EventIntegrityService(
      item.connection,
      LIFECYCLE_SCHEMA_MIGRATIONS,
      [new LifecycleIntegrityService(item.connection)],
    );
    const suspensionReport = suspensionIntegrity.fullCheck(item.primary);
    assert.equal(
      suspensionReport.issues.some((issue) => issue.code === "SESSION_AUTHORITY_FOLD_MISMATCH"),
      false,
      JSON.stringify(suspensionReport.issues),
    );

    const preTicketRoot = item.authority.get(item.connection, PROJECT_ID, preTicketStart.publicResult.sessionId)!;
    const preTicketAggregate = item.authority.requireFoldMatch(item.connection, preTicketRoot);
    const invalidOldRootClaim: ClaimChildTransferCommandV2 = {
      ...base(7_151),
      commandType: "claim-child-transfer",
      rootSessionId: preTicketStart.publicResult.sessionId as ClaimChildTransferCommandV2["rootSessionId"],
      transferTicketId: suspended.publicResult.transferTicketId as ClaimChildTransferCommandV2["transferTicketId"],
      expectedStreamVersion: preTicketAggregate.streamVersion.toString(),
    };
    assert.throws(
      () => item.workflow.execute(item.primary, prepare(item, item.primary, invalidOldRootClaim, {
        authoritySessionId: preTicketStart.publicResult.sessionId,
        targetSessionId: preTicketStart.publicResult.sessionId,
        capabilityKind: "root-session-handle",
        capabilityGeneration: preTicketStart.publicResult.ownerGeneration,
        material: preTicketAuthority,
      })),
      (error) => errorCode(error) === "SESSION_STATE_CONFLICT",
    );

    const futureStart = item.processor.startRoot(item.primary, preparedStart(item.primary, startCommand(7_200))) as RootStartSuccess;
    assert.equal(futureStart.kind, "success");
    assert.ok(futureStart.authorityMaterial.descriptor !== null && futureStart.authorityMaterial.target !== null);
    const futureAuthority = item.capabilities.reconstructForTarget(
      futureStart.authorityMaterial.descriptor,
      futureStart.authorityMaterial.target,
    );
    item.childAuthorities.push(futureAuthority);
    seedSessionCheckpoint(item, futureStart.publicResult.sessionId, 270_000);
    const futureRoot = item.authority.get(item.connection, PROJECT_ID, futureStart.publicResult.sessionId)!;
    const futureAggregate = item.authority.requireFoldMatch(item.connection, futureRoot);
    const claim: ClaimChildTransferCommandV2 = {
      ...base(7_201),
      commandType: "claim-child-transfer",
      rootSessionId: futureStart.publicResult.sessionId as ClaimChildTransferCommandV2["rootSessionId"],
      transferTicketId: suspended.publicResult.transferTicketId as ClaimChildTransferCommandV2["transferTicketId"],
      expectedStreamVersion: futureAggregate.streamVersion.toString(),
    };
    const preparedClaim = prepare(item, item.primary, claim, {
      authoritySessionId: futureStart.publicResult.sessionId,
      targetSessionId: futureStart.publicResult.sessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: futureStart.publicResult.ownerGeneration,
      material: futureAuthority,
    });
    const claimed = success(item.workflow.execute(item.primary, preparedClaim));
    assert.notEqual(claimed.publicResult.childSessionId, oldChildId);
    assert.equal(claimed.publicResult.previousChildSessionId, oldChildId);
    const newChild = childAggregate(item, claimed.publicResult.childSessionId);
    assert.equal(newChild.aggregate.kind, "child");
    if (newChild.aggregate.kind !== "child") assert.fail("claimed session must be a child");
    assert.equal(newChild.aggregate.parentSessionId, futureStart.publicResult.sessionId);
    assert.equal(newChild.aggregate.correlationId, futureAggregate.correlationId);
    assert.equal(newChild.aggregate.sourceTransferTicketId, suspended.publicResult.transferTicketId);
    assert.equal(newChild.aggregate.streamVersion, 2n);
    assert.equal(newChild.authority.checkpointRequiredReason, "carry-forward-claim");
    assert.equal(typeof claimed.publicResult.eventPosition, "string");
    assert.equal(
      newChild.authority.checkpointRequiredEventPosition,
      BigInt(claimed.publicResult.eventPosition!),
    );
    assert.equal(childAggregate(item, oldChildId).aggregate.parentSessionId, item.root.publicResult.sessionId);
    const oldLineage = item.connection.prepare(`
      SELECT event_id, event_type, causation_id FROM events
      WHERE project_id = $projectId AND session_id = $sessionId
      ORDER BY stream_version
    `).all({ $projectId: PROJECT_ID, $sessionId: oldChildId });
    const checkpointEvent = oldLineage.find((event) => event.event_type === "SessionCheckpointRecorded");
    const suspendedEvent = oldLineage.find((event) => event.event_type === "ChildSessionSuspended");
    const transferEvent = oldLineage.find((event) => event.event_type === "ChildWorkTransferCreated");
    assert.equal(suspendedEvent?.causation_id, checkpointEvent?.event_id);
    assert.equal(transferEvent?.causation_id, suspendedEvent?.event_id);
    const claimedLineage = item.connection.prepare(`
      SELECT event_id, event_type, causation_id FROM events
      WHERE project_id = $projectId AND session_id = $sessionId
      ORDER BY stream_version
    `).all({ $projectId: PROJECT_ID, $sessionId: claimed.publicResult.childSessionId });
    assert.equal(claimedLineage[0]?.event_type, "SessionForked");
    assert.equal(claimedLineage[0]?.causation_id, transferEvent?.event_id);
    assert.equal(claimedLineage[1]?.event_type, "ChildWorkTransferClaimed");
    assert.equal(claimedLineage[1]?.causation_id, claimedLineage[0]?.event_id);
    const claimedTicket = item.transfers.get(item.connection, PROJECT_ID, suspended.publicResult.transferTicketId!);
    assert.equal(claimedTicket?.claimedByRootSessionId, futureStart.publicResult.sessionId);
    assert.equal(claimedTicket?.claimedChildSessionId, claimed.publicResult.childSessionId);
    const claimIntegrity = new EventIntegrityService(
      item.connection,
      LIFECYCLE_SCHEMA_MIGRATIONS,
      [new LifecycleIntegrityService(item.connection)],
    ).fullCheck(item.primary);
    assert.equal(
      claimIntegrity.issues.some((issue) => (issue.code === "COMMAND_HASH_MISMATCH"
        || issue.code === "COMMAND_METADATA_MISMATCH")
        && issue.commandId === claim.commandId),
      false,
      JSON.stringify(claimIntegrity.issues),
    );
    assert.equal(
      claimIntegrity.issues.some((issue) => issue.code === "SESSION_AUTHORITY_FOLD_MISMATCH"),
      false,
      JSON.stringify(claimIntegrity.issues),
    );
    const eventCountAfterClaim = item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count;
    const authorityCountAfterClaim = item.connection.prepare("SELECT COUNT(*) AS count FROM session_authority").get()?.count;
    const dedupCountAfterClaim = item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count;
    const exactReplay = success(item.workflow.execute(item.primary, preparedClaim));
    assert.deepEqual(exactReplay.publicResult, claimed.publicResult);
    assert.equal(exactReplay.publicResult.childSessionId, claimed.publicResult.childSessionId);
    assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, eventCountAfterClaim);
    assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM session_authority").get()?.count, authorityCountAfterClaim);
    assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count, dedupCountAfterClaim);

    const losingClaim = { ...claim, commandId: lifecycleUuid(7_202), idempotencyKey: "child/7202" };
    assert.throws(
      () => item.workflow.execute(item.primary, prepare(item, item.primary, losingClaim, {
        authoritySessionId: futureStart.publicResult.sessionId,
        targetSessionId: futureStart.publicResult.sessionId,
        capabilityKind: "root-session-handle",
        capabilityGeneration: futureStart.publicResult.ownerGeneration,
        material: futureAuthority,
      })),
      (error) => errorCode(error) === "EVENT_CONFLICT",
    );
  });

  it("rolls back child events, authority, and dedup when a claim faults before the ticket CAS", () => {
    const item = fixture();
    const scenario = claimScenario(item, 9_000);
    const before = {
      events: item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
      authority: item.connection.prepare("SELECT COUNT(*) AS count FROM session_authority").get()?.count,
      dedup: item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
    };
    let seamHits = 0;
    const faultingWorkflow = workflowFor(item, item.connection, item.store, (point) => {
      assert.equal(point, "after-child-effects-before-ticket-cas");
      seamHits += 1;
      throw new Error("injected claim fault");
    });
    assert.throws(
      () => faultingWorkflow.execute(item.primary, scenario.preparedClaim),
      /injected claim fault/u,
    );
    assert.equal(seamHits, 1);
    assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, before.events);
    assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM session_authority").get()?.count, before.authority);
    assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count, before.dedup);
    const unclaimed = item.transfers.get(item.connection, PROJECT_ID, scenario.suspended.publicResult.transferTicketId!);
    assert.equal(unclaimed?.claimedEventPosition, null);
    assert.equal(unclaimed?.claimedChildSessionId, null);

    const retried = success(item.workflow.execute(item.primary, scenario.preparedClaim));
    assert.equal(retried.publicResult.previousChildSessionId, scenario.oldChildId);
    assert.equal(
      item.transfers.get(item.connection, PROJECT_ID, scenario.suspended.publicResult.transferTicketId!)?.claimedChildSessionId,
      retried.publicResult.childSessionId,
    );
  });

  it("rejects carry-forward claim when a destination child checkpoint fingerprint is corrupt", () => {
    const item = fixture();
    const scenario = claimScenario(item, 9_200);
    const destinationRootId = scenario.futureStart.publicResult.sessionId;
    const destinationRoot = item.authority.get(item.connection, PROJECT_ID, destinationRootId);
    assert.ok(destinationRoot !== null);
    const destinationAggregate = item.authority.requireFoldMatch(item.connection, destinationRoot);
    const siblingCommand: ForkChildCommandV2 = {
      ...base(9_450),
      commandType: "fork-child",
      parentSessionId: destinationRootId as ForkChildCommandV2["parentSessionId"],
      expectedStreamVersion: destinationAggregate.streamVersion.toString(),
      assignment: {
        assignmentId: lifecycleUuid(9_451),
        summary: "Destination sibling",
        scope: "scope/destination-sibling",
      },
      directAccessRequested: false,
    };
    const sibling = success(item.workflow.execute(item.primary, prepare(item, item.primary, siblingCommand, {
      authoritySessionId: destinationRootId,
      targetSessionId: destinationRootId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: scenario.futureStart.publicResult.ownerGeneration,
      material: scenario.futureAuthority,
    })));
    seedChildCheckpoint(item, sibling.publicResult.childSessionId, 9_452);
    seedSessionCheckpoint(item, destinationRootId, 9_454);
    const corruptedSibling = corruptLatestCheckpointFingerprint(item, sibling.publicResult.childSessionId);
    const currentDestination = item.authority.get(item.connection, PROJECT_ID, destinationRootId);
    assert.ok(currentDestination !== null);
    const currentDestinationAggregate = item.authority.requireFoldMatch(item.connection, currentDestination);
    const claim: ClaimChildTransferCommandV2 = {
      ...base(9_456),
      commandType: "claim-child-transfer",
      rootSessionId: destinationRootId as ClaimChildTransferCommandV2["rootSessionId"],
      transferTicketId: scenario.suspended.publicResult.transferTicketId as ClaimChildTransferCommandV2["transferTicketId"],
      expectedStreamVersion: currentDestinationAggregate.streamVersion.toString(),
    };
    const preparedClaim = prepare(item, item.primary, claim, {
      authoritySessionId: destinationRootId,
      targetSessionId: destinationRootId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: scenario.futureStart.publicResult.ownerGeneration,
      material: scenario.futureAuthority,
    });
    const ticketBefore = item.transfers.get(item.connection, PROJECT_ID, claim.transferTicketId);
    assert.ok(ticketBefore !== null && ticketBefore.claimedEventPosition === null);
    const effectsBefore = {
      events: item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
      dedup: item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
      authority: item.connection.prepare("SELECT COUNT(*) AS count FROM session_authority").get()?.count,
    };

    assert.throws(
      () => item.workflow.execute(item.primary, preparedClaim),
      (error: unknown) => errorCode(error) === "INTEGRITY_FAILURE",
    );
    assert.equal(item.checkpointSourceCaptures.count, 0);
    assert.deepEqual(item.authority.get(item.connection, PROJECT_ID, destinationRootId), currentDestination);
    assert.deepEqual(
      item.authority.get(item.connection, PROJECT_ID, corruptedSibling.sessionId),
      corruptedSibling,
    );
    assert.deepEqual(item.transfers.get(item.connection, PROJECT_ID, claim.transferTicketId), ticketBefore);
    assert.deepEqual({
      events: item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
      dedup: item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
      authority: item.connection.prepare("SELECT COUNT(*) AS count FROM session_authority").get()?.count,
    }, effectsBefore);
  });

  it("detects a raw-deleted transfer index from both full integrity and claim lookup", () => {
    const item = fixture();
    const scenario = claimScenario(item, 9_500);
    const integrity = new EventIntegrityService(
      item.connection,
      LIFECYCLE_SCHEMA_MIGRATIONS,
      [new LifecycleIntegrityService(item.connection)],
    );
    const baselineReport = integrity.fullCheck(item.primary);
    assert.equal(
      baselineReport.issues.some((issue) => issue.code === "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
      false,
      JSON.stringify(baselineReport.issues),
    );
    const removed = item.connection.prepare(`
      DELETE FROM child_transfer_tickets
      WHERE project_id = $projectId AND transfer_ticket_id = $transferTicketId
    `).run({
      $projectId: PROJECT_ID,
      $transferTicketId: scenario.suspended.publicResult.transferTicketId!,
    });
    assert.equal(removed.changes, 1n);
    const report = integrity.fullCheck(item.primary);
    assert.equal(report.ok, false);
    assert.equal(report.issues.some((issue) => issue.code === "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"), true);
    assert.throws(
      () => item.workflow.execute(item.primary, scenario.preparedClaim),
      (error) => errorCode(error) === "INTEGRITY_FAILURE",
    );
  });

  it("rejects a forged ticket payload even when it reuses the real transfer event identity", () => {
    const item = fixture();
    const scenario = claimScenario(item, 9_700);
    const ticketId = scenario.suspended.publicResult.transferTicketId!;
    const ticket = item.transfers.get(item.connection, PROJECT_ID, ticketId);
    assert.ok(ticket !== null && typeof ticket.sourceAssignment === "object" && ticket.sourceAssignment !== null);
    item.connection.prepare(`
      DELETE FROM child_transfer_tickets
      WHERE project_id = $projectId AND transfer_ticket_id = $transferTicketId
    `).run({ $projectId: PROJECT_ID, $transferTicketId: ticketId });
    item.transfers.insert(item.connection, {
      projectId: ticket.projectId,
      transferTicketId: ticket.transferTicketId,
      sourceParentSessionId: ticket.sourceParentSessionId,
      sourceChildSessionId: ticket.sourceChildSessionId,
      sourceAssignment: {
        ...(ticket.sourceAssignment as Readonly<Record<string, JsonValue>>),
        summary: "forged assignment summary",
      },
      sourceScope: ticket.sourceScope,
      checkpointId: ticket.checkpointId,
      blockers: ticket.blockers,
      followUps: ticket.followUps,
      sourceState: ticket.sourceState,
      lineage: ticket.lineage,
      createdEventPosition: ticket.createdEventPosition,
      createdAtMs: ticket.createdAtMs,
    });
    assert.throws(
      () => item.workflow.execute(item.primary, scenario.preparedClaim),
      (error) => errorCode(error) === "INTEGRITY_FAILURE",
    );
  });

  it("detects every immutable transfer-ticket source field tampered behind canonical JSON", () => {
    const item = fixture();
    const scenario = claimScenario(item, 9_800);
    const ticketId = scenario.suspended.publicResult.transferTicketId!;
    const original = item.connection.prepare(`
      SELECT *
      FROM child_transfer_tickets
      WHERE project_id = $projectId AND transfer_ticket_id = $transferTicketId
    `).get({ $projectId: PROJECT_ID, $transferTicketId: ticketId });
    assert.ok(original !== undefined);
    const assignment = JSON.parse(original.source_assignment_json as string) as Record<string, JsonValue>;
    const scope = JSON.parse(original.source_scope_json as string) as Record<string, JsonValue>;
    const sourceState = JSON.parse(original.source_state_json as string) as Record<string, JsonValue>;
    const lineage = JSON.parse(original.lineage_json as string) as Record<string, JsonValue>;
    const annotations = JSON.parse(original.follow_ups_json as string) as [Record<string, JsonValue>];
    const annotation = annotations[0]!;
    const tampers = [
      ["assignment", "source_assignment_json", canonicalJson({ ...assignment, summary: "tampered summary" })],
      ["scope", "source_scope_json", canonicalJson({ ...scope, scope: "scope/tampered" })],
      ["sourceState", "source_state_json", canonicalJson({ ...sourceState, dirtyWorktreeFingerprint: "f".repeat(64) })],
      ["lineage", "lineage_json", canonicalJson({ ...lineage, correlationId: lifecycleUuid(9_899) })],
      ["blockers", "follow_ups_json", canonicalJson([{ ...annotation, blockers: ["tampered blocker"] }])],
      ["followUps", "follow_ups_json", canonicalJson([{ ...annotation, followUps: ["tampered follow-up"] }])],
      ["createdAt", "created_at", "2026-07-18T00:00:01.000Z"],
    ] as const;
    const integrity = new EventIntegrityService(
      item.connection,
      LIFECYCLE_SCHEMA_MIGRATIONS,
      [new LifecycleIntegrityService(item.connection)],
    );
    const baseline = integrity.fullCheck(item.primary);
    assert.equal(
      baseline.issues.some((issue) => issue.code === "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
      false,
      JSON.stringify(baseline.issues),
    );
    const replaceTicket = (column: string, value: unknown) => {
      const row = { ...original, [column]: value };
      item.connection.prepare(`
        DELETE FROM child_transfer_tickets
        WHERE project_id = $projectId AND transfer_ticket_id = $transferTicketId
      `).run({ $projectId: PROJECT_ID, $transferTicketId: ticketId });
      item.connection.prepare(`
        INSERT INTO child_transfer_tickets(
          project_id, transfer_ticket_id, source_parent_session_id, source_child_session_id,
          source_assignment_json, source_scope_json, checkpoint_id, follow_ups_json,
          source_state_json, lineage_json, created_event_position, created_at,
          claimed_by_root_session_id, claimed_child_session_id, claimed_event_position, claimed_at
        ) VALUES (
          $projectId, $transferTicketId, $sourceParentSessionId, $sourceChildSessionId,
          $sourceAssignmentJson, $sourceScopeJson, $checkpointId, $followUpsJson,
          $sourceStateJson, $lineageJson, $createdEventPosition, $createdAt,
          $claimedByRootSessionId, $claimedChildSessionId, $claimedEventPosition, $claimedAt
        )
      `).run({
        $projectId: row.project_id,
        $transferTicketId: row.transfer_ticket_id,
        $sourceParentSessionId: row.source_parent_session_id,
        $sourceChildSessionId: row.source_child_session_id,
        $sourceAssignmentJson: row.source_assignment_json,
        $sourceScopeJson: row.source_scope_json,
        $checkpointId: row.checkpoint_id,
        $followUpsJson: row.follow_ups_json,
        $sourceStateJson: row.source_state_json,
        $lineageJson: row.lineage_json,
        $createdEventPosition: row.created_event_position,
        $createdAt: row.created_at,
        $claimedByRootSessionId: row.claimed_by_root_session_id,
        $claimedChildSessionId: row.claimed_child_session_id,
        $claimedEventPosition: row.claimed_event_position,
        $claimedAt: row.claimed_at,
      } as SqliteParams);
    };
    const undetected: string[] = [];
    for (const [label, column, value] of tampers) {
      replaceTicket(column, value);
      const report = integrity.fullCheck(item.primary);
      if (!report.issues.some((issue) => issue.code === "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH")) {
        undetected.push(label);
      }
      replaceTicket(column, original[column]);
    }
    assert.deepEqual(undetected, []);
    const restored = integrity.fullCheck(item.primary);
    assert.equal(
      restored.issues.some((issue) => issue.code === "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
      false,
      JSON.stringify(restored.issues),
    );
  });

  it("has one transfer-claim winner across two real SQLite connections", () => {
    const item = fileFixture();
    const scenario = claimScenario(item, 10_000);
    assert.ok(item.cleanupDirectory !== null);
    const secondConnection = new NativeConnection(join(item.cleanupDirectory, "events.sqlite"));
    secondConnection.exec("PRAGMA busy_timeout = 1");
    item.additionalConnections.push(secondConnection);
    const secondRuntime = commandRuntime({
      connection: secondConnection,
      authority: item.authority,
      leases: item.leases,
      approvals: item.approvals,
      transfers: item.transfers,
      ids: item.ids,
      clock: item.clock,
    });
    const secondWorkflow = workflowFor(item, secondConnection, secondRuntime.store);
    const competingClaim: ClaimChildTransferCommandV2 = {
      ...scenario.claim,
      commandId: lifecycleUuid(10_202),
      idempotencyKey: "child/10202",
    };
    const competingPrepared = prepare(item, item.primary, competingClaim, {
      authoritySessionId: scenario.futureStart.publicResult.sessionId,
      targetSessionId: scenario.futureStart.publicResult.sessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: scenario.futureStart.publicResult.ownerGeneration,
      material: scenario.futureAuthority,
    });
    let contentionError: unknown;
    const winningWorkflow = workflowFor(item, item.connection, item.store, () => {
      try {
        secondWorkflow.execute(item.primary, competingPrepared);
      } catch (error) {
        contentionError = error;
      }
    });
    const winner = success(winningWorkflow.execute(item.primary, scenario.preparedClaim));
    assert.ok(contentionError !== undefined, "the second connection must observe live writer contention");
    assert.equal(
      errorCode(contentionError) === "EVENT_CONFLICT"
        || /busy|locked/iu.test(contentionError instanceof Error ? contentionError.message : String(contentionError)),
      true,
    );
    assert.throws(
      () => secondWorkflow.execute(item.primary, competingPrepared),
      (error) => errorCode(error) === "EVENT_CONFLICT",
    );
    const ticket = item.transfers.get(item.connection, PROJECT_ID, scenario.suspended.publicResult.transferTicketId!);
    assert.equal(ticket?.claimedChildSessionId, winner.publicResult.childSessionId);
    assert.equal(ticket?.claimedByRootSessionId, scenario.futureStart.publicResult.sessionId);
    assert.equal(
      item.connection.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'ChildWorkTransferClaimed'").get()?.count,
      1n,
    );
  });

  it("leaves root owner generation unchanged through 32 child operations and exposes active-child diagnostics", () => {
    const item = fixture();
    for (let index = 0; index < 32; index += 1) {
      const result = success(fork(item, 8_000 + index, false));
      assert.equal(result.publicResult.rootOwnerGeneration, "1");
    }
    const root = item.authority.get(item.connection, PROJECT_ID, item.root.publicResult.sessionId)!;
    assert.equal(root.ownerGeneration, 1n);
    assert.equal(item.leases.current(item.connection, PROJECT_ID, root.sessionId)?.ownerGeneration, 1n);
    const read = protectedTreeRead(item, 8_100);
    const diagnostic = item.query.activeChildDiagnostic(item.primary, read);
    assert.equal(diagnostic.activeChildCount, 32);
    assert.equal(diagnostic.activeChildren.length, 32);
    assert.equal(diagnostic.activeChildren.every((childSummary) => childSummary.state === "active"), true);
    assert.equal(diagnostic.childrenTruncated, false);
    assert.equal(diagnostic.requiresResolution, true);
    assert.equal(JSON.stringify(diagnostic).includes("pmcap1"), false);
    assert.throws(
      () => item.query.activeChildDiagnostic(context("different-primary"), read),
      (error) => errorCode(error) === "LIFECYCLE_INPUT_INVALID",
    );
  });
});
