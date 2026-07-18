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
  SuspendChildSessionCommandV2,
} from "../src/orchestrator/lifecycle/contracts/commands.js";
import type { ChildDispositionV1, ChildReportDraftV1 } from "../src/orchestrator/lifecycle/contracts/child.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import { LifecycleCommandProcessor } from "../src/orchestrator/lifecycle/lifecycle-command.processor.js";
import { LifecycleCommandStore } from "../src/orchestrator/lifecycle/lifecycle-command.store.js";
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
import type { SessionAuthorityRecord } from "../src/orchestrator/storage/lifecycle-storage.types.js";
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
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";

const NOW = "2026-07-18T00:00:00.000Z";
const NOW_MS = BigInt(Date.parse(NOW));
const TARGET_BINDING_FINGERPRINT = "d".repeat(64);

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
  uuid(): string { return lifecycleUuid(this.#next++); }
  bytes(length: number): Uint8Array { return Buffer.alloc(length, this.#next++ % 251); }
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
}

const fixtures: Fixture[] = [];

function commandRuntime(options: {
  readonly connection: NativeConnection;
  readonly authority: SessionAuthorityRepository;
  readonly leases: SessionLeaseRepository;
  readonly approvals: LifecycleApprovalRepository;
  readonly transfers: ChildTransferRepository;
  readonly ids: DeterministicIds;
  readonly clock: TestClock;
}): { readonly events: EventAppendTransaction; readonly store: LifecycleCommandStore } {
  const { connection, authority, leases, approvals, transfers, ids, clock } = options;
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
        insert: (input: Parameters<ChildTransferRepository["insert"]>[1]) => transfers.insert(current, input),
        claim: (input: Parameters<ChildTransferRepository["claim"]>[1]) => transfers.claim(current, input),
      },
      coverage: {}, workflows: {}, validation: {}, outbox: {},
    }),
    now: () => new Date(Number(clock.nowMs())).toISOString(),
  });
  return { events, store };
}

function fixture(databasePath = ":memory:", cleanupDirectory: string | null = null): Fixture {
  assert.ok(ChildWorkflowServiceClass, "ChildWorkflowService must implement scoped child behavior");
  const connection = new NativeConnection(databasePath);
  new MigrationRunner().apply(connection, PROJECT_STORE_MIGRATIONS, NOW, { kind: "bootstrap-empty" });
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
  const { events, store } = commandRuntime({ connection, authority, leases, approvals, transfers, ids, clock });
  const primary = context();
  const childContext = context("child-1", "untrusted");
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
    resumeSourceState: { captureCurrent: () => { throw new Error("unused"); } },
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
    additionalConnections: [], cleanupDirectory,
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

function seedChildCheckpoint(item: Fixture, childSessionId: string, ordinal: number) {
  const { authority, aggregate } = childAggregate(item, childSessionId);
  assert.equal(aggregate.kind, "child");
  const nextPosition = (item.connection.prepare(
    "SELECT COALESCE(MAX(global_position), 0) + 1 AS position FROM events",
  ).get()?.position) as bigint;
  type CheckpointOptions = NonNullable<Parameters<typeof checkpointFixture>[0]>;
  const checkpoint = checkpointFixture({
    sessionId: childSessionId as CheckpointOptions["sessionId"],
    parentSessionId: authority.parentSessionId as CheckpointOptions["parentSessionId"],
    checkpointId: lifecycleUuid(ordinal) as CheckpointOptions["checkpointId"],
    baseEventPosition: aggregate.eventPosition,
    checkpointEventPosition: nextPosition,
  });
  const append: AppendCommand<JsonValue> = {
    context: item.childContext,
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
      sessionId: childSessionId,
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
    const updated = item.connection.prepare(`
      UPDATE session_authority
      SET latest_checkpoint_id = $checkpointId,
          latest_checkpoint_event_position = $position,
          latest_checkpoint_fingerprint = $fingerprint,
          updated_at = $updatedAt
      WHERE project_id = $projectId AND session_id = $sessionId
        AND authority_commitment = $commitment
    `).run({
      $checkpointId: checkpoint.checkpointId,
      $position: nextPosition,
      $fingerprint: fingerprint,
      $updatedAt: NOW,
      $projectId: PROJECT_ID,
      $sessionId: childSessionId,
      $commitment: authority.authorityCommitment,
    });
    assert.equal(updated.changes, 1n);
    item.connection.exec("COMMIT");
  } catch (error) {
    item.connection.exec("ROLLBACK");
    throw error;
  }
  return checkpoint;
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

function success(result: WorkerLifecycleResult<ChildWorkflowResultV2>) {
  assert.equal(result.kind, "success");
  if (result.kind !== "success") assert.fail("expected child workflow success");
  return result;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof LifecycleError ? error.code : undefined;
}

describe("scoped child lifecycle", () => {
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
      PROJECT_STORE_MIGRATIONS,
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
      PROJECT_STORE_MIGRATIONS,
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
      PROJECT_STORE_MIGRATIONS,
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
    assert.equal(childAggregate(item, oldChildId).authority.revocationReasonCode, "child-transferred");
    assert.deepEqual(
      reportPayloads(item, oldChildId, "ChildSessionSuspended").map((payload) => payload.blockers),
      [suspend.blockers],
    );
    assert.equal(reportPayloads(item, oldChildId, "ChildWorkTransferCreated").length, 1);
    const suspensionIntegrity = new EventIntegrityService(
      item.connection,
      PROJECT_STORE_MIGRATIONS,
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
      PROJECT_STORE_MIGRATIONS,
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

  it("detects a raw-deleted transfer index from both full integrity and claim lookup", () => {
    const item = fixture();
    const scenario = claimScenario(item, 9_500);
    const integrity = new EventIntegrityService(
      item.connection,
      PROJECT_STORE_MIGRATIONS,
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
      PROJECT_STORE_MIGRATIONS,
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
