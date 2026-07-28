import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { AppendCommand, JsonValue } from "../src/orchestrator/contracts/event.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import type {
  PreparedLifecycleWorkerCommand,
  BoundedLifecycleOperation,
  RedactedLifecycleApproval,
  RootRecoveryCommandV2,
  RootResumeCommandV2,
  RootStartCommandV2,
  RootSuspendCommandV2,
} from "../src/orchestrator/lifecycle/contracts/commands.js";
import type {
  CheckpointDraftV1,
  SourceStateFingerprintV1,
} from "../src/orchestrator/lifecycle/contracts/checkpoint.js";
import {
  createCapabilityProof,
  type BoundedOperationProofTargetV1,
  type SemanticCommandProofTargetV1,
} from "../src/orchestrator/lifecycle/authority/capability-codec.js";
import { authorityCommitment } from "../src/orchestrator/lifecycle/authority/authority-commitment.js";
import { CapabilityService } from "../src/orchestrator/lifecycle/capability.service.js";
import { LifecycleCommandStore } from "../src/orchestrator/lifecycle/lifecycle-command.store.js";
import { buildLifecycleIntentWitness } from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import {
  EventAppendTransaction,
  SqliteEventAppendStatements,
} from "../src/orchestrator/storage/event-append-transaction.js";
import { LifecycleApprovalRepository } from "../src/orchestrator/storage/lifecycle-approval.repository.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { MigrationRunner } from "../src/orchestrator/storage/migration-runner.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { SessionAuthorityRepository } from "../src/orchestrator/storage/session-authority.repository.js";
import { SessionLeaseRepository } from "../src/orchestrator/storage/session-lease.repository.js";
import type {
  RootLeaseRecord,
  SafeResumeCandidateQuery,
  SessionAuthorityRecord,
} from "../src/orchestrator/storage/lifecycle-storage.types.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";
import type { WorkerLifecycleResult } from "../src/orchestrator/lifecycle/authority/authority-material-adapter.js";
import { DeterministicCapabilityKeyProvider } from "./support/lifecycle-authority-reference.js";
import {
  PROJECT_ID,
  STORE_ID,
  VAULT_ID,
  WORKSPACE_ID,
  checkpointFixture,
  lifecycleUuid,
} from "./support/lifecycle-fixtures.js";

const NOW = "2026-07-17T00:00:00.000Z";
const LIFECYCLE_SCHEMA_MIGRATIONS = PROJECT_STORE_MIGRATIONS.slice(0, 2);
const NOW_MS = BigInt(Date.parse(NOW));
const OWNER_LEASE_MS = 120_000n;

function healthyCoverageFacade() {
  return {
    assertEvidenceWindowWritable: () => undefined,
    assertQuickHealthy: () => undefined,
    registerAffectedExistingSessions: () => undefined,
    assertVersion1Eligible: () => undefined,
    prepareBatch: () => { throw new Error("evidence coverage not used"); },
    persistPrepared: () => undefined,
    snapshotV2: () => { throw new Error("evidence coverage not used"); },
    minimumCheckpointUpperBound: () => 0,
    minimumFinalEndingScopeBindingsUpperBound: () => 0,
  };
}

type RootSessionPublicResultV2 = {
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
  readonly state: string;
  readonly resumedFromSessionId: string | null;
  readonly latestCheckpointEventPosition: string | null;
  readonly eventPosition: string;
  readonly handleIssued: boolean;
  readonly resumeTokenIssued: boolean;
  readonly contextPackUnavailable: true;
};

interface LifecycleCommandProcessorLike {
  startRoot(
    projectContext: ProjectContext,
    command: PreparedLifecycleWorkerCommand<RootStartCommandV2>,
  ): WorkerLifecycleResult<RootSessionPublicResultV2>;
  resumeRoot(
    projectContext: ProjectContext,
    command: PreparedLifecycleWorkerCommand<RootResumeCommandV2>,
  ): WorkerLifecycleResult<RootSessionPublicResultV2>;
  suspendRoot(
    projectContext: ProjectContext,
    command: PreparedLifecycleWorkerCommand<RootSuspendCommandV2>,
  ): WorkerLifecycleResult<RootSessionPublicResultV2>;
  recoverRoot(
    projectContext: ProjectContext,
    command: PreparedLifecycleWorkerCommand<RootRecoveryCommandV2>,
  ): WorkerLifecycleResult<RootSessionPublicResultV2>;
  renewRootLease(
    projectContext: ProjectContext,
    operation: Extract<BoundedLifecycleOperation, { operation: "renew-root-lease" }>,
  ): unknown;
}

type LifecycleCommandProcessorConstructor = new (
  options: Record<string, unknown>,
) => LifecycleCommandProcessorLike;

type ProtectedReadOperation = Exclude<
  BoundedLifecycleOperation,
  { readonly operation: "renew-root-lease" }
>;

interface LifecycleQueryServiceLike {
  read(projectContext: ProjectContext, operation: ProtectedReadOperation): unknown;
}

type LifecycleQueryServiceConstructor = new (
  options: Record<string, unknown>,
) => LifecycleQueryServiceLike;

async function loadProcessorConstructor(): Promise<LifecycleCommandProcessorConstructor | null> {
  const modulePath = [
    "../src/orchestrator/lifecycle/lifecycle-command",
    ".processor.js",
  ].join("");
  try {
    const loaded = await import(modulePath) as {
      readonly LifecycleCommandProcessor?: LifecycleCommandProcessorConstructor;
    };
    return loaded.LifecycleCommandProcessor ?? null;
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  }
}

async function loadQueryConstructor(): Promise<LifecycleQueryServiceConstructor | null> {
  const modulePath = [
    "../src/orchestrator/lifecycle/lifecycle-query",
    ".service.js",
  ].join("");
  try {
    const loaded = await import(modulePath) as {
      readonly LifecycleQueryService?: LifecycleQueryServiceConstructor;
    };
    return loaded.LifecycleQueryService ?? null;
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  }
}

class NativeStatement implements SqliteStatement {
  constructor(private readonly statement: import("node:sqlite").StatementSync) {
    statement.setReadBigInts(true);
  }

  run(params?: SqliteParams): SqliteRunResult {
    const result = params === undefined ? this.statement.run() : this.statement.run(params);
    return {
      changes: result.changes as bigint,
      lastInsertRowid: result.lastInsertRowid as bigint,
    };
  }

  get(params?: SqliteParams): SqliteRow | undefined {
    return (params === undefined ? this.statement.get() : this.statement.get(params)) as
      | SqliteRow
      | undefined;
  }

  all(params?: SqliteParams): SqliteRow[] {
    return (params === undefined ? this.statement.all() : this.statement.all(params)) as SqliteRow[];
  }

  iterate(params?: SqliteParams): IterableIterator<SqliteRow> {
    return (params === undefined ? this.statement.iterate() : this.statement.iterate(params)) as
      IterableIterator<SqliteRow>;
  }
}

class NativeConnection implements SqliteConnection {
  readonly transactionStatements: string[] = [];
  readonly database = new DatabaseSync(":memory:", {
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });

  exec(sql: string): void {
    const normalized = sql.trim().replace(/;$/u, "").toUpperCase();
    if (normalized === "BEGIN IMMEDIATE" || normalized === "COMMIT" || normalized === "ROLLBACK") {
      this.transactionStatements.push(normalized);
    }
    this.database.exec(sql);
  }
  prepare(sql: string): SqliteStatement { return new NativeStatement(this.database.prepare(sql)); }
  close(): void { this.database.close(); }
}

class DeterministicIds {
  #next = 1_000;
  uuid(): string {
    const value = lifecycleUuid(this.#next);
    this.#next += 1;
    return value;
  }
  bytes(length: number): Uint8Array {
    const value = Buffer.alloc(length, this.#next % 255);
    this.#next += 1;
    return value;
  }
}

class TestClock {
  now = NOW_MS;
  nowMs(): bigint { return this.now; }
}

function context(
  clientInstanceId = "primary-1",
  actorRole: ProjectContext["binding"]["actorRole"] = "primary",
  checkedAt = NOW,
  contextFingerprint = "f".repeat(64),
): ProjectContext {
  const workspace = {
    kind: "non-git" as const,
    workspaceRoot: "C:\\project",
    workspaceId: WORKSPACE_ID,
  };
  return {
    binding: {
      projectBindingId: `binding-${clientInstanceId}`,
      generation: 1,
      contextFingerprint,
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
    checkedAt,
  };
}

function gitContext(clientInstanceId = "primary-2"): ProjectContext {
  const base = context(clientInstanceId);
  const workspace = {
    kind: "git" as const,
    worktreeRoot: "C:\\project",
    gitDir: "C:\\project\\.git",
    gitCommonDir: "C:\\project\\.git",
    headCommit: "a".repeat(40),
    branchRef: "refs/heads/main",
    detached: false,
    workspaceId: WORKSPACE_ID,
  };
  return {
    ...base,
    binding: { ...base.binding, workspace },
    workspace,
  };
}

function startCommand(
  ordinal: number,
  continuityKey = "thread-7",
): RootStartCommandV2 {
  return {
    commandType: "root-start",
    commandId: lifecycleUuid(ordinal),
    idempotencyKey: `root-start/${ordinal}`,
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    continuityKey,
    resumePolicy: "new",
  };
}

function preparedStart(
  projectContext: ProjectContext,
  command: RootStartCommandV2,
): PreparedLifecycleWorkerCommand<RootStartCommandV2> {
  const candidateIntentHash = buildLifecycleIntentWitness(command, {
    authorizationKind: "initial-authority",
    authorizationSessionId: null,
    targetSessionId: lifecycleUuid(999),
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
  ordinal: number,
  sessionId: string | null,
  ownerGeneration: string,
  continuityKey: string | null = "thread-7",
  resumePolicy: "exact" | "latest-safe" = "exact",
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
    sessionId: sessionId as RootResumeCommandV2["sessionId"],
    continuityKey,
    resumePolicy,
    expectedOwnerGeneration: ownerGeneration,
  };
}

function preparedResume(
  item: Fixture,
  projectContext: ProjectContext,
  issued: Extract<WorkerLifecycleResult<RootSessionPublicResultV2>, { kind: "success" }>,
  command: RootResumeCommandV2,
): PreparedLifecycleWorkerCommand<RootResumeCommandV2> {
  const descriptor = issued.authorityMaterial.descriptor;
  const descriptorTarget = issued.authorityMaterial.target;
  assert.ok(descriptor !== null && descriptorTarget !== null);
  const material = item.capabilities.reconstructForTarget(descriptor, descriptorTarget);
  try {
    assert.equal(material.kind, "root");
    if (material.kind !== "root" || material.resumeToken === null) {
      assert.fail("root resume token must be available");
    }
    const candidateIntentHash = buildLifecycleIntentWitness(command, {
      authorizationKind: "protected",
      authorizationSessionId: issued.publicResult.sessionId,
      targetSessionId: issued.publicResult.sessionId,
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
      authoritySessionId: issued.publicResult.sessionId,
      targetSessionId: issued.publicResult.sessionId,
      presentingActorRole: "primary",
      presentingClientInstanceId: projectContext.binding.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: projectContext.binding.clientInstanceId,
      capabilityKind: "root-resume-token",
      capabilityGeneration: command.expectedOwnerGeneration,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: candidateIntentHash,
      proofNonce: lifecycleUuid(Number(command.commandId.slice(-12)) + 10_000),
    };
    return {
      command,
      candidateIntentHash,
      authorization: {
        kind: "protected",
        authoritySessionId: issued.publicResult.sessionId as NonNullable<RootResumeCommandV2["sessionId"]>,
        targetSessionId: issued.publicResult.sessionId as NonNullable<RootResumeCommandV2["sessionId"]>,
        proof: createCapabilityProof(material.resumeToken, target),
        approval: null,
        childBindingGrant: null,
      },
    };
  } finally {
    material.handle.destroy();
    if (material.kind === "root") material.resumeToken?.destroy();
  }
}

function checkpointDraft(): CheckpointDraftV1 {
  return {
    checkpointVersion: 1,
    taskSummary: "Suspend root at a durable checkpoint",
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

function suspendCommand(
  ordinal: number,
  sessionId: string,
  expectedStreamVersion: string,
): RootSuspendCommandV2 {
  return {
    commandType: "root-suspend",
    commandId: lifecycleUuid(ordinal),
    idempotencyKey: `root-suspend/${ordinal}`,
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: sessionId as RootSuspendCommandV2["sessionId"],
    expectedStreamVersion,
    checkpoint: checkpointDraft(),
  };
}

function preparedSuspend(
  item: Fixture,
  projectContext: ProjectContext,
  issued: Extract<WorkerLifecycleResult<RootSessionPublicResultV2>, { kind: "success" }>,
  command: RootSuspendCommandV2,
): PreparedLifecycleWorkerCommand<RootSuspendCommandV2> {
  const descriptor = issued.authorityMaterial.descriptor;
  const descriptorTarget = issued.authorityMaterial.target;
  assert.ok(descriptor !== null && descriptorTarget !== null);
  const material = item.capabilities.reconstructForTarget(descriptor, descriptorTarget);
  try {
    assert.equal(material.kind, "root");
    const candidateIntentHash = buildLifecycleIntentWitness(command, {
      authorizationKind: "protected",
      authorizationSessionId: command.sessionId,
      targetSessionId: command.sessionId,
      projectId: projectContext.binding.projectId,
      vaultId: projectContext.binding.vaultId,
      storeId: projectContext.binding.storeId,
      workspaceId: projectContext.binding.workspaceId,
      clientNamespace: projectContext.binding.clientNamespace,
      capabilityKind: "root-session-handle",
      capabilityGeneration: issued.publicResult.ownerGeneration,
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
      authoritySessionId: command.sessionId,
      targetSessionId: command.sessionId,
      presentingActorRole: "primary",
      presentingClientInstanceId: projectContext.binding.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: projectContext.binding.clientInstanceId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: issued.publicResult.ownerGeneration,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: candidateIntentHash,
      proofNonce: lifecycleUuid(Number(command.commandId.slice(-12)) + 20_000),
    };
    return {
      command,
      candidateIntentHash,
      authorization: {
        kind: "protected",
        authoritySessionId: command.sessionId,
        targetSessionId: command.sessionId,
        proof: createCapabilityProof(material.handle, target),
        approval: null,
        childBindingGrant: null,
      },
    };
  } finally {
    material.handle.destroy();
    if (material.kind === "root") material.resumeToken?.destroy();
  }
}

function recoveryCommand(
  ordinal: number,
  sessionId: string,
  expectedOwnerGeneration: string,
  preTransitionCheckpointId: string,
): RootRecoveryCommandV2 {
  return {
    commandType: "root-recovery",
    commandId: lifecycleUuid(ordinal),
    idempotencyKey: `root-recovery/${ordinal}`,
    agentId: "agent-maintenance",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: sessionId as RootRecoveryCommandV2["sessionId"],
    expectedOwnerGeneration,
    preTransitionCheckpointId: preTransitionCheckpointId as RootRecoveryCommandV2["preTransitionCheckpointId"],
    reasonCode: "credential-loss",
  };
}

function preparedRecovery(
  item: Fixture,
  projectContext: ProjectContext,
  command: RootRecoveryCommandV2,
  targetClientInstanceId: string,
): PreparedLifecycleWorkerCommand<RootRecoveryCommandV2> {
  const candidateIntentHash = buildLifecycleIntentWitness(command, {
    authorizationKind: "protected",
    authorizationSessionId: command.sessionId,
    targetSessionId: command.sessionId,
    projectId: projectContext.binding.projectId,
    vaultId: projectContext.binding.vaultId,
    storeId: projectContext.binding.storeId,
    workspaceId: projectContext.binding.workspaceId,
    clientNamespace: projectContext.binding.clientNamespace,
    capabilityKind: null,
    capabilityGeneration: null,
    presentingActorRole: projectContext.binding.actorRole,
    presentingClientInstanceId: projectContext.binding.clientInstanceId,
    targetActorRole: "primary",
    targetClientInstanceId,
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).intentHash;
  const issuedAt = new Date(Number(item.clock.now)).toISOString();
  const approval: RedactedLifecycleApproval = {
    approvalVersion: 1,
    approvalId: lifecycleUuid(Number(command.commandId.slice(-12)) + 30_000),
    action: "recover-root-authority",
    reasonCode: command.reasonCode,
    approvalFingerprint: "a".repeat(64),
    nonceDigest: "b".repeat(64),
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: command.sessionId,
    expectedOwnerGeneration: command.expectedOwnerGeneration,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    intentHash: candidateIntentHash,
    executorActorRole: projectContext.binding.actorRole as "primary" | "maintenance",
    executorClientInstanceId: projectContext.binding.clientInstanceId,
    targetActorRole: "primary",
    targetClientInstanceId,
    issuedAt,
    expiresAt: new Date(Number(item.clock.now + 600_000n)).toISOString(),
    redactedApprovalReference: `approval/${command.commandId}`,
  };
  return {
    command,
    candidateIntentHash,
    authorization: {
      kind: "protected",
      authoritySessionId: command.sessionId,
      targetSessionId: command.sessionId,
      proof: null,
      approval,
      childBindingGrant: null,
    },
  };
}

function withRecoveryApproval(
  prepared: PreparedLifecycleWorkerCommand<RootRecoveryCommandV2>,
  overrides: Partial<RedactedLifecycleApproval>,
): PreparedLifecycleWorkerCommand<RootRecoveryCommandV2> {
  assert.equal(prepared.authorization.kind, "protected");
  const approval = prepared.authorization.approval;
  assert.ok(approval !== null);
  return {
    ...prepared,
    authorization: {
      ...prepared.authorization,
      approval: { ...approval, ...overrides },
    },
  };
}

function boundedRenewalHash(input: {
  readonly operationId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly expectedOwnerGeneration: number;
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

function boundedReadHash(input: {
  readonly operationType: ProtectedReadOperation["operation"];
  readonly operationId: string;
  readonly requestId: string;
  readonly sessionId: string;
}): string {
  return createHash("sha256")
    .update("project-memory/bounded-operation/v1\n", "utf8")
    .update(canonicalJson({
      operationType: input.operationType,
      operationId: input.operationId,
      requestId: input.requestId,
      sessionId: input.sessionId,
    }), "utf8")
    .digest("hex");
}

function protectedReadOperation(
  item: Fixture,
  projectContext: ProjectContext,
  issued: Extract<WorkerLifecycleResult<RootSessionPublicResultV2>, { kind: "success" }>,
  ordinal: number,
  operationType: ProtectedReadOperation["operation"],
  targetOverrides: Partial<BoundedOperationProofTargetV1> = {},
): ProtectedReadOperation {
  const descriptor = issued.authorityMaterial.descriptor;
  const descriptorTarget = issued.authorityMaterial.target;
  assert.ok(descriptor !== null && descriptorTarget !== null);
  const material = item.capabilities.reconstructForTarget(descriptor, descriptorTarget);
  try {
    assert.equal(material.kind, "root");
    const operationId = lifecycleUuid(ordinal);
    const requestId = lifecycleUuid(ordinal + 10_000);
    const sessionId = issued.publicResult.sessionId;
    const audience = {
      presentingActorRole: "primary" as const,
      presentingClientInstanceId: projectContext.binding.clientInstanceId,
      targetActorRole: "primary" as const,
      targetClientInstanceId: projectContext.binding.clientInstanceId,
    };
    const target: BoundedOperationProofTargetV1 = {
      proofVersion: 1,
      target: "bounded-operation",
      operationType,
      operationId,
      requestId,
      operationHash: boundedReadHash({ operationType, operationId, requestId, sessionId }),
      authoritySessionId: sessionId,
      targetSessionId: sessionId,
      ...audience,
      capabilityGeneration: issued.publicResult.ownerGeneration,
      proofNonce: lifecycleUuid(ordinal + 20_000),
      expiresAt: new Date(Date.parse(projectContext.checkedAt) + Number(OWNER_LEASE_MS)).toISOString(),
      ...targetOverrides,
    };
    return {
      context: projectContext,
      operation: operationType,
      operationId,
      requestId,
      sessionId: sessionId as ProtectedReadOperation["sessionId"],
      authorization: {
        kind: "bounded-operation",
        authoritySessionId: target.authoritySessionId as ProtectedReadOperation["authorization"]["authoritySessionId"],
        targetSessionId: target.targetSessionId as ProtectedReadOperation["authorization"]["targetSessionId"],
        proof: createCapabilityProof(material.handle, target),
        audience,
      },
    } as ProtectedReadOperation;
  } finally {
    material.handle.destroy();
    if (material.kind === "root") material.resumeToken?.destroy();
  }
}

function renewalOperation(
  item: Fixture,
  projectContext: ProjectContext,
  issued: Extract<WorkerLifecycleResult<RootSessionPublicResultV2>, { kind: "success" }>,
  ordinal: number,
  targetOverrides: Partial<BoundedOperationProofTargetV1> = {},
): Extract<BoundedLifecycleOperation, { operation: "renew-root-lease" }> {
  const descriptor = issued.authorityMaterial.descriptor;
  const descriptorTarget = issued.authorityMaterial.target;
  assert.ok(descriptor !== null && descriptorTarget !== null);
  const material = item.capabilities.reconstructForTarget(descriptor, descriptorTarget);
  try {
    assert.equal(material.kind, "root");
    const operationId = lifecycleUuid(ordinal);
    const requestId = lifecycleUuid(ordinal + 10_000);
    const expectedOwnerGeneration = Number(issued.publicResult.ownerGeneration);
    const sessionId = issued.publicResult.sessionId;
    const operationHash = boundedRenewalHash({
      operationId,
      requestId,
      sessionId,
      expectedOwnerGeneration,
    });
    const audience = {
      presentingActorRole: "primary" as const,
      presentingClientInstanceId: projectContext.binding.clientInstanceId,
      targetActorRole: "primary" as const,
      targetClientInstanceId: projectContext.binding.clientInstanceId,
    };
    const target: BoundedOperationProofTargetV1 = {
      proofVersion: 1,
      target: "bounded-operation",
      operationType: "renew-root-lease",
      operationId,
      requestId,
      operationHash,
      authoritySessionId: sessionId,
      targetSessionId: sessionId,
      ...audience,
      capabilityGeneration: issued.publicResult.ownerGeneration,
      proofNonce: lifecycleUuid(ordinal + 20_000),
      expiresAt: new Date(Date.parse(projectContext.checkedAt) + Number(OWNER_LEASE_MS)).toISOString(),
      ...targetOverrides,
    };
    return {
      context: projectContext,
      operation: "renew-root-lease",
      operationId,
      requestId,
      sessionId: sessionId as Extract<BoundedLifecycleOperation, { operation: "renew-root-lease" }>["sessionId"],
      expectedOwnerGeneration,
      authorization: {
        kind: "bounded-operation",
        authoritySessionId: target.authoritySessionId as Extract<BoundedLifecycleOperation, { operation: "renew-root-lease" }>["authorization"]["authoritySessionId"],
        targetSessionId: target.targetSessionId as Extract<BoundedLifecycleOperation, { operation: "renew-root-lease" }>["authorization"]["targetSessionId"],
        proof: createCapabilityProof(material.handle, target),
        audience,
      },
    };
  } finally {
    material.handle.destroy();
    if (material.kind === "root") material.resumeToken?.destroy();
  }
}

function success(
  result: WorkerLifecycleResult<RootSessionPublicResultV2>,
): Extract<WorkerLifecycleResult<RootSessionPublicResultV2>, { kind: "success" }> {
  assert.equal(result.kind, "success");
  if (result.kind !== "success") assert.fail("expected lifecycle success");
  return result;
}

interface Fixture {
  readonly connection: NativeConnection;
  readonly events: EventAppendTransaction;
  readonly authority: SessionAuthorityRepository;
  readonly leases: SessionLeaseRepository;
  readonly processor: LifecycleCommandProcessorLike;
  readonly capabilities: CapabilityService;
  readonly clock: TestClock;
  readonly operationTrace: string[];
  readonly selectionTrace: string[];
  readonly approvalEventCounts: bigint[];
}

interface FixtureOptions {
  readonly resumeCandidates?: (
    input: SafeResumeCandidateQuery,
    actual: readonly SessionAuthorityRecord[],
  ) => readonly SessionAuthorityRecord[];
  readonly resumeSourceState?: (context: ProjectContext) => SourceStateFingerprintV1;
  readonly continuityOwners?: (
    actual: readonly SessionAuthorityRecord[],
  ) => readonly SessionAuthorityRecord[];
  readonly assertQuickHealthy?: (context: ProjectContext) => void;
  readonly currentLease?: (actual: RootLeaseRecord | null) => RootLeaseRecord | null;
  readonly eventFault?: (
    boundary: "before-begin" | "after-first-insert-before-commit" | "after-commit-before-response",
  ) => void;
}

function checkpointSourceState(projectContext: ProjectContext): SourceStateFingerprintV1 {
  return Object.freeze({
    sourceStateScopeVersion: 1,
    workspaceId: projectContext.workspace.workspaceId,
    branchRef: projectContext.workspace.kind === "git" ? projectContext.workspace.branchRef : null,
    headCommit: projectContext.workspace.kind === "git" ? projectContext.workspace.headCommit : null,
    dirtyWorktreeFingerprint: createHash("sha256")
      .update("project-memory/checkpoint-context/v1\n", "utf8")
      .update(projectContext.binding.contextFingerprint, "utf8")
      .digest("hex"),
  });
}

function fixture(
  Processor: LifecycleCommandProcessorConstructor,
  options: FixtureOptions = {},
): Fixture {
  const connection = new NativeConnection();
  new MigrationRunner().apply(connection, LIFECYCLE_SCHEMA_MIGRATIONS, NOW, {
    kind: "bootstrap-empty", beforeMigration: () => undefined,
  });
  connection.exec("BEGIN IMMEDIATE");
  connection.prepare(`
    INSERT INTO project_meta(singleton, project_id, vault_id, store_id, schema_version, created_at)
    VALUES (1, $projectId, $vaultId, $storeId, 2, $createdAt)
  `).run({
    $projectId: PROJECT_ID,
    $vaultId: VAULT_ID,
    $storeId: STORE_ID,
    $createdAt: NOW,
  });
  connection.exec(`
    INSERT INTO maintenance_state(
      singleton, epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at
    ) VALUES (1, 0, 'idle', NULL, 0, NULL, NULL)
  `);
  connection.exec("COMMIT");

  const ids = new DeterministicIds();
  const clock = new TestClock();
  const provider = new DeterministicCapabilityKeyProvider();
  const capabilityService = new CapabilityService({
    keyProvider: provider,
    clock,
    nonceSource: ids,
  });
  const authority = new SessionAuthorityRepository();
  const leases = new SessionLeaseRepository();
  const approvals = new LifecycleApprovalRepository();
  const operationTrace: string[] = [];
  const selectionTrace: string[] = [];
  const approvalEventCounts: bigint[] = [];
  const events = new EventAppendTransaction(
    connection,
    new SqliteEventAppendStatements(connection),
    new MaintenanceFence(),
    new BranchScopeRepository(),
    () => ids.uuid(),
    { hit: (boundary) => options.eventFault?.(boundary) },
  );
  const store = new LifecycleCommandStore({
    connection,
    events,
    transaction: (current) => ({
      authority: {
        get: (projectId: string, sessionId: string) => authority.get(current, projectId, sessionId),
        insertRoot: (input: Parameters<SessionAuthorityRepository["insertRoot"]>[1]) =>
          authority.insertRoot(current, input),
        compareAndSwap: (input: Parameters<SessionAuthorityRepository["compareAndSwap"]>[1]) =>
          (operationTrace.push(`authority-cas/${input.next.ownerGeneration?.toString() ?? "child"}`),
          authority.compareAndSwap(current, input)),
        listSafeResumeCandidates: (
          input: Parameters<SessionAuthorityRepository["listSafeResumeCandidates"]>[1],
        ) => {
          selectionTrace.push("candidate-query");
          const actual = authority.listSafeResumeCandidates(current, input);
          return options.resumeCandidates?.(input, actual) ?? actual;
        },
        listNonterminalRootContinuityOwners: (
          input: Parameters<SessionAuthorityRepository["listNonterminalRootContinuityOwners"]>[1],
        ) => {
          const actual = authority.listNonterminalRootContinuityOwners(current, input);
          return options.continuityOwners?.(actual) ?? actual;
        },
        latestCheckpoint: (
          input: Parameters<SessionAuthorityRepository["latestCheckpoint"]>[1],
        ) => (selectionTrace.push("checkpoint"), authority.latestCheckpoint(current, input)),
        listNonterminalChildren: (
          projectId: string,
          rootSessionId: string,
        ) => (operationTrace.push("children-list"),
        authority.listNonterminalChildren(current, projectId, rootSessionId)),
        rootContinuityKey: (
          input: Parameters<SessionAuthorityRepository["rootContinuityKey"]>[1],
        ) => authority.rootContinuityKey(current, input),
        nextGlobalPosition: () => {
          const row = current.prepare(`
            SELECT COALESCE(MAX(global_position), 0) AS globalPosition FROM events
          `).get();
          assert.equal(typeof row?.globalPosition, "bigint");
          return (row?.globalPosition as bigint) + 1n;
        },
        requireFoldMatch: (input: Parameters<SessionAuthorityRepository["requireFoldMatch"]>[1]) =>
          (selectionTrace.push("fold"), authority.requireFoldMatch(current, input)),
        markCheckpointRequired: (
          input: Parameters<SessionAuthorityRepository["markCheckpointRequired"]>[1],
        ) => authority.markCheckpointRequired(current, input),
      },
      leases: {
        current: (projectId: string, sessionId: string) => {
          selectionTrace.push("lease-current");
          const actual = leases.current(current, projectId, sessionId);
          return options.currentLease === undefined ? actual : options.currentLease(actual);
        },
        isExpired: (lease: Parameters<SessionLeaseRepository["isExpired"]>[0], now: bigint) =>
          (selectionTrace.push("lease-expiry"), leases.isExpired(lease, now)),
        insertGeneration: (input: Parameters<SessionLeaseRepository["insertGeneration"]>[1]) =>
          (operationTrace.push(`lease-insert/${input.ownerGeneration.toString()}`),
          leases.insertGeneration(current, input)),
        renewCurrent: (input: Parameters<SessionLeaseRepository["renewCurrent"]>[1]) =>
          (operationTrace.push(`lease-renew/${input.ownerGeneration.toString()}`),
          leases.renewCurrent(current, input)),
        releaseCurrent: (input: Parameters<SessionLeaseRepository["releaseCurrent"]>[1]) =>
          (operationTrace.push(`lease-release/${input.ownerGeneration.toString()}`),
          leases.releaseCurrent(current, input)),
      },
      approvals: {
        consume: (input: Parameters<LifecycleApprovalRepository["consume"]>[1]) =>
          (operationTrace.push("approval-consume"),
          approvalEventCounts.push(current.prepare("SELECT COUNT(*) AS count FROM events").get()?.count as bigint),
          approvals.consume(current, input)),
      },
      transfers: {},
      coverage: healthyCoverageFacade(),
      workflows: {},
      validation: {},
      outbox: {},
    }),
    now: () => new Date(Number(clock.nowMs())).toISOString(),
  });
  const processorCapabilities = new Proxy(capabilityService, {
    get: (target, property) => {
      if (property === "verifyProof") {
        return (...arguments_: Parameters<CapabilityService["verifyProof"]>) => {
          selectionTrace.push("proof");
          return target.verifyProof(...arguments_);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const processor = new Processor({
    connection,
    commandStore: store,
    authorityRepository: authority,
    leaseRepository: leases,
    approvalRepository: approvals,
    capabilityService: processorCapabilities,
    clock,
    identitySource: ids,
    integrity: { assertQuickHealthy: (projectContext: ProjectContext) => options.assertQuickHealthy?.(projectContext) },
    resumeSourceState: {
      captureCurrent: (projectContext: ProjectContext) => {
        selectionTrace.push("source-capture");
        return options.resumeSourceState?.(projectContext) ?? checkpointSourceState(projectContext);
      },
    },
    checkpointSourceStateProvider: {
      capture: async (projectContext: ProjectContext) => checkpointSourceState(projectContext),
      captureForCheckpoint: (projectContext: ProjectContext) => checkpointSourceState(projectContext),
      captureForFinalization: (projectContext: ProjectContext) => checkpointSourceState(projectContext),
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
  return {
    connection,
    events,
    authority,
    leases,
    processor,
    capabilities: capabilityService,
    clock,
    operationTrace,
    selectionTrace,
    approvalEventCounts,
  };
}

function seedRootCheckpoint(item: Fixture, sessionId: string, ordinal: number) {
  const authority = item.authority.get(item.connection, PROJECT_ID, sessionId);
  assert.ok(authority !== null && authority.sessionKind === "root");
  const aggregate = item.authority.requireFoldMatch(item.connection, authority);
  assert.equal(aggregate.kind, "root");
  if (aggregate.kind !== "root") assert.fail("root aggregate required");
  const nextPosition = item.connection.prepare(
    "SELECT COALESCE(MAX(global_position), 0) + 1 AS position FROM events",
  ).get()?.position as bigint;
  const projectContext = context(authority.rootHandleClientInstanceId ?? "checkpoint-seed");
  const children = item.authority.listNonterminalChildren(item.connection, PROJECT_ID, sessionId)
    .map((child) => {
      const childAggregate = item.authority.requireFoldMatch(item.connection, child);
      if (childAggregate.kind !== "child") assert.fail("child aggregate required");
      return {
        childSessionId: child.sessionId,
        state: childAggregate.state,
        lastEventPosition: childAggregate.eventPosition.toString(),
        streamVersion: childAggregate.streamVersion.toString(),
        latestCheckpointId: childAggregate.latestCheckpointId,
      };
    })
    .sort((left, right) => left.childSessionId.localeCompare(right.childSessionId));
  type CheckpointOptions = NonNullable<Parameters<typeof checkpointFixture>[0]>;
  const checkpoint = Object.freeze({
    ...checkpointFixture({
      sessionId: sessionId as CheckpointOptions["sessionId"],
      parentSessionId: null,
      checkpointId: lifecycleUuid(ordinal) as CheckpointOptions["checkpointId"],
      baseEventPosition: nextPosition - 1n,
      checkpointEventPosition: nextPosition,
    }),
    sourceState: checkpointSourceState(projectContext),
    childSummaries: Object.freeze(children),
  });
  const fingerprint = createHash("sha256")
    .update("project-memory/checkpoint/v1\n", "utf8")
    .update(canonicalJson(checkpoint as unknown as JsonValue), "utf8")
    .digest("hex");
  const occurredAt = new Date(Number(item.clock.nowMs())).toISOString();
  const append: AppendCommand<JsonValue> = {
    context: projectContext,
    commandId: lifecycleUuid(ordinal + 1),
    idempotencyKey: `seed-root-checkpoint/${ordinal}`,
    commandType: "seed-root-checkpoint",
    correlationId: aggregate.correlationId,
    agentId: "agent-primary",
    expectedStreamVersion: aggregate.streamVersion,
    streamId: authority.streamId,
    streamType: "session",
    events: [{
      eventType: "SessionCheckpointRecorded",
      eventSchemaVersion: 1,
      occurredAt,
      visibilityScope: "session",
      sessionId,
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
  item.connection.exec("BEGIN IMMEDIATE");
  try {
    const prepared = item.events.prepare(append, occurredAt);
    const planned = item.events.planPrepared(prepared);
    assert.equal(planned.events[0]?.globalPosition, nextPosition);
    item.events.appendPlanned(planned);
    assert.equal(item.authority.updateCheckpointIndex(item.connection, {
      projectId: PROJECT_ID,
      sessionId,
      expectedLatestCheckpointId: authority.latestCheckpointId,
      expectedLatestCheckpointEventPosition: authority.latestCheckpointEventPosition,
      expectedLatestCheckpointFingerprint: authority.latestCheckpointFingerprint,
      checkpointId: checkpoint.checkpointId,
      checkpointEventPosition: nextPosition,
      checkpointFingerprint: fingerprint,
      updatedAt: occurredAt,
    }), true);
    if (authority.checkpointRequiredEventPosition !== null) {
      assert.equal(item.authority.clearCheckpointRequired(item.connection, {
        projectId: PROJECT_ID,
        sessionId,
        checkpointBaseEventPosition: nextPosition - 1n,
        updatedAt: occurredAt,
      }), true);
    }
    item.connection.exec("COMMIT");
  } catch (error) {
    item.connection.exec("ROLLBACK");
    throw error;
  }
  return checkpoint;
}

function transitionRootToEnding(
  item: Fixture,
  projectContext: ProjectContext,
  sessionId: string,
  ordinal: number,
): SessionAuthorityRecord {
  const current = item.authority.get(item.connection, PROJECT_ID, sessionId);
  assert.ok(current !== null && current.sessionKind === "root");
  const aggregate = item.authority.requireFoldMatch(item.connection, current);
  assert.equal(aggregate.kind, "root");
  if (aggregate.kind !== "root") assert.fail("root aggregate required");
  assert.ok(aggregate.state === "active" || aggregate.state === "suspended");
  const occurredAt = new Date(Number(item.clock.nowMs())).toISOString();
  item.connection.exec("BEGIN IMMEDIATE");
  try {
    item.events.assertAppendAllowed();
    const prepared = item.events.prepare({
      context: projectContext,
      commandId: lifecycleUuid(ordinal),
      idempotencyKey: `seed-ending/${ordinal}`,
      commandType: "request-session-end",
      correlationId: aggregate.correlationId,
      agentId: "agent-primary",
      expectedStreamVersion: aggregate.streamVersion,
      streamId: current.streamId,
      streamType: "session",
      events: [{
        eventType: "SessionEndRequested",
        eventSchemaVersion: 1,
        occurredAt,
        visibilityScope: "session",
        sessionId,
        confidence: "high",
        verificationStatus: "verified",
        payload: {
          workflowId: lifecycleUuid(ordinal + 1),
          workflowGeneration: 1,
          previousState: aggregate.state,
          childEndPolicy: "require-completed",
          qualityThreshold: 10_000,
          requireFullEvidence: false,
          requireMaterialization: false,
        },
        sourceRefs: [],
        evidenceRefs: [],
        evidenceDigests: [],
      }],
      outbox: [],
      publicResponse: { seededEnding: true },
    }, occurredAt);
    const planned = item.events.planPrepared(prepared);
    const updated = item.connection.prepare(`
      UPDATE session_authority
      SET semantic_state = 'ending', updated_at = $updatedAt
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND semantic_state = $expectedState
    `).run({
      $updatedAt: occurredAt,
      $projectId: PROJECT_ID,
      $sessionId: sessionId,
      $expectedState: aggregate.state,
    });
    assert.equal(updated.changes, 1n);
    item.events.appendPlanned(planned);
    item.connection.exec("COMMIT");
  } catch (error) {
    item.connection.exec("ROLLBACK");
    throw error;
  }
  const ending = item.authority.get(item.connection, PROJECT_ID, sessionId);
  assert.ok(ending !== null);
  assert.equal(ending.semanticState, "ending");
  item.authority.requireFoldMatch(item.connection, ending);
  return ending;
}

function seedOpaqueChildSentinel(
  item: Fixture,
  parentSessionId: string,
): { readonly sessionId: string; readonly row: SqliteRow } {
  const sessionId = lifecycleUuid(990);
  const streamId = `session/${sessionId}`;
  item.connection.exec("BEGIN IMMEDIATE");
  try {
    item.connection.prepare(`
      INSERT INTO streams(project_id, stream_id, stream_type, current_version, created_at, updated_at)
      VALUES ($projectId, $streamId, 'session', 0, $now, $now)
    `).run({
      $projectId: PROJECT_ID,
      $streamId: streamId,
      $now: NOW,
    });
    const inserted = item.connection.prepare(`
      INSERT INTO session_authority(
        project_id, session_id, stream_id, session_kind, parent_session_id,
        workspace_id, client_namespace, semantic_state, owner_generation,
        child_capability_generation, direct_access_enabled,
        continuity_fingerprint_algorithm, continuity_fingerprint_schema_version,
        continuity_fingerprint_key_id, continuity_fingerprint_domain, continuity_fingerprint,
        root_handle_capability_version, root_handle_key_id, root_handle_issue_nonce,
        root_handle_issued_at, root_handle_policy_code, root_handle_expiry_kind,
        root_handle_expires_at, root_handle_actor_role, root_handle_client_instance_id,
        root_handle_verifier, root_handle_issuance_id,
        resume_token_capability_version, resume_token_key_id, resume_token_issue_nonce,
        resume_token_issued_at, resume_token_policy_code, resume_token_expiry_kind,
        resume_token_expires_at, resume_token_actor_role, resume_token_verifier,
        resume_token_issuance_id,
        child_handle_capability_version, child_handle_key_id, child_handle_issue_nonce,
        child_handle_issued_at, child_handle_policy_code, child_handle_expiry_kind,
        child_handle_expires_at, child_handle_actor_role, child_handle_client_instance_id,
        child_handle_verifier, child_handle_issuance_id,
        authority_commitment, authority_event_position,
        latest_checkpoint_id, latest_checkpoint_event_position, latest_checkpoint_fingerprint,
        checkpoint_required_reason, checkpoint_required_event_position,
        revocation_reason_code, revocation_event_position, revoked_at,
        terminal_event_position, terminal_event_type, terminal_at, created_at, updated_at
      ) VALUES (
        $projectId, $sessionId, $streamId, 'child', $parentSessionId,
        $workspaceId, 'desktop/tests', 'active', NULL,
        NULL, 0,
        NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        $authorityCommitment, 1,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        $now, $now
      )
    `).run({
      $projectId: PROJECT_ID,
      $sessionId: sessionId,
      $streamId: streamId,
      $parentSessionId: parentSessionId,
      $workspaceId: WORKSPACE_ID,
      $authorityCommitment: "c".repeat(64),
      $now: NOW,
    });
    assert.equal(inserted.changes, 1n);
    item.connection.exec("COMMIT");
  } catch (error) {
    item.connection.exec("ROLLBACK");
    throw error;
  }
  const row = item.connection.prepare(`
    SELECT * FROM session_authority WHERE project_id = $projectId AND session_id = $sessionId
  `).get({ $projectId: PROJECT_ID, $sessionId: sessionId });
  assert.ok(row !== undefined);
  return { sessionId, row };
}

describe("LifecycleCommandProcessor root start", () => {
  it("creates generation-one authority, lease, commitment, and private descriptor atomically", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null, "LifecycleCommandProcessor must implement root start");
    const item = fixture(Processor);
    try {
      const projectContext = context();
      const issued = success(item.processor.startRoot(
        projectContext,
        preparedStart(projectContext, startCommand(100, "thread-7")),
      ));

      assert.deepEqual(issued.publicResult.project, {
        projectId: PROJECT_ID,
        vaultId: VAULT_ID,
        storeId: STORE_ID,
        workspaceId: WORKSPACE_ID,
        clientNamespace: "desktop/tests",
      });
      assert.equal(issued.publicResult.ownerGeneration, "1");
      assert.equal(issued.publicResult.continuityKey, "thread-7");
      assert.equal(issued.publicResult.state, "active");
      assert.equal(issued.publicResult.resumedFromSessionId, null);
      assert.equal(issued.publicResult.handleIssued, true);
      assert.equal(issued.publicResult.resumeTokenIssued, true);
      assert.equal(issued.publicResult.contextPackUnavailable, true);
      assert.equal(issued.authorityMaterial.status, "current");
      assert.equal(issued.authorityMaterial.target?.clientInstanceId, "primary-1");
      assert.equal(issued.authorityMaterial.descriptor?.materials.length, 2);

      const authority = item.authority.get(
        item.connection,
        PROJECT_ID,
        issued.publicResult.sessionId,
      );
      assert.ok(authority !== null);
      assert.equal(authority.ownerGeneration, 1n);
      assert.equal(authority.authorityEventPosition, BigInt(issued.publicResult.eventPosition));
      assert.equal(authority.rootHandleClientInstanceId, "primary-1");
      assert.equal(authority.authorityCommitment, authorityCommitment({
        authorityVersion: 1,
        projectId: authority.projectId,
        sessionId: authority.sessionId,
        sessionKind: authority.sessionKind,
        parentSessionId: authority.parentSessionId,
        workspaceId: authority.workspaceId,
        clientNamespace: authority.clientNamespace,
        ownerGeneration: authority.ownerGeneration?.toString() ?? null,
        childCapabilityGeneration: authority.childCapabilityGeneration?.toString() ?? null,
        directAccessEnabled: authority.directAccessEnabled,
        continuityFingerprintAlgorithm: authority.continuityFingerprintAlgorithm,
        continuityFingerprintSchemaVersion: authority.continuityFingerprintSchemaVersion,
        continuityFingerprintKeyId: authority.continuityFingerprintKeyId,
        continuityFingerprintDomain: authority.continuityFingerprintDomain,
        continuityFingerprint: authority.continuityFingerprint,
        rootHandleCapabilityVersion: authority.rootHandleCapabilityVersion,
        rootHandleKeyId: authority.rootHandleKeyId,
        rootHandleIssueNonce: authority.rootHandleIssueNonce,
        rootHandleIssuedAt: authority.rootHandleIssuedAt,
        rootHandlePolicyCode: authority.rootHandlePolicyCode,
        rootHandleExpiryKind: authority.rootHandleExpiryKind,
        rootHandleExpiresAt: authority.rootHandleExpiresAt,
        rootHandleActorRole: authority.rootHandleActorRole,
        rootHandleClientInstanceId: authority.rootHandleClientInstanceId,
        rootHandleVerifier: authority.rootHandleVerifier,
        resumeTokenCapabilityVersion: authority.resumeTokenCapabilityVersion,
        resumeTokenKeyId: authority.resumeTokenKeyId,
        resumeTokenIssueNonce: authority.resumeTokenIssueNonce,
        resumeTokenIssuedAt: authority.resumeTokenIssuedAt,
        resumeTokenPolicyCode: authority.resumeTokenPolicyCode,
        resumeTokenExpiryKind: authority.resumeTokenExpiryKind,
        resumeTokenExpiresAt: authority.resumeTokenExpiresAt,
        resumeTokenActorRole: authority.resumeTokenActorRole,
        resumeTokenVerifier: authority.resumeTokenVerifier,
        childHandleCapabilityVersion: authority.childHandleCapabilityVersion,
        childHandleKeyId: authority.childHandleKeyId,
        childHandleIssueNonce: authority.childHandleIssueNonce,
        childHandleIssuedAt: authority.childHandleIssuedAt,
        childHandlePolicyCode: authority.childHandlePolicyCode,
        childHandleExpiryKind: authority.childHandleExpiryKind,
        childHandleExpiresAt: authority.childHandleExpiresAt,
        childHandleActorRole: authority.childHandleActorRole,
        childHandleClientInstanceId: authority.childHandleClientInstanceId,
        childHandleVerifier: authority.childHandleVerifier,
        revocationReasonCode: authority.revocationReasonCode,
        revocationEventPosition: authority.revocationEventPosition?.toString() ?? null,
        revokedAt: authority.revokedAt,
        terminalEventPosition: authority.terminalEventPosition?.toString() ?? null,
        terminalEventType: authority.terminalEventType,
        terminalAt: authority.terminalAt,
      }));
      const lease = item.leases.current(item.connection, PROJECT_ID, authority.sessionId);
      assert.ok(lease !== null);
      assert.equal(lease.ownerGeneration, 1n);
      assert.equal(lease.ownerClientInstanceId, "primary-1");
      assert.equal(lease.expiresAtMs - lease.lastObservedAtMs, OWNER_LEASE_MS);

      const stored = item.connection.prepare(`
        SELECT response_json FROM command_dedup WHERE command_id = $commandId
      `).get({ $commandId: startCommand(100).commandId });
      assert.doesNotMatch(String(stored?.response_json), /pmcap1|descriptor|authorityMaterial|proof/i);
    } finally {
      item.connection.close();
    }
  });

  it("does not let a second root supersede the current continuity owner", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null, "LifecycleCommandProcessor must implement continuity fencing");
    const item = fixture(Processor);
    try {
      const firstContext = context("primary-1");
      const first = success(item.processor.startRoot(
        firstContext,
        preparedStart(firstContext, startCommand(101, "thread-7")),
      ));
      const secondContext = context("primary-2");
      assert.throws(
        () => item.processor.startRoot(
          secondContext,
          preparedStart(secondContext, startCommand(102, "thread-7")),
        ),
        (error: unknown) => (error as { code?: string }).code === "CONTINUITY_CONFLICT",
      );

      const current = item.authority.get(item.connection, PROJECT_ID, first.publicResult.sessionId);
      assert.ok(current !== null);
      assert.equal(current.semanticState, "active");
      assert.equal(current.ownerGeneration, 1n);
      assert.equal(current.rootHandleClientInstanceId, "primary-1");
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 1n);
    } finally {
      item.connection.close();
    }
  });

  it("treats an ending nonterminal continuity owner as a collision", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const seed = fixture(Processor);
    let endingOwner: SessionAuthorityRecord;
    try {
      const primary = context("primary-ending-seed");
      const started = success(seed.processor.startRoot(
        primary,
        preparedStart(primary, startCommand(105, "ending-continuity")),
      ));
      const current = seed.authority.get(seed.connection, PROJECT_ID, started.publicResult.sessionId);
      assert.ok(current !== null);
      endingOwner = { ...current, semanticState: "ending" };
    } finally {
      seed.connection.close();
    }
    const item = fixture(Processor, { continuityOwners: () => [endingOwner] });
    try {
      const primary = context("primary-ending-new");
      assert.throws(
        () => item.processor.startRoot(
          primary,
          preparedStart(primary, startCommand(106, "ending-continuity")),
        ),
        (error: unknown) => (error as { code?: string }).code === "CONTINUITY_CONFLICT",
      );
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 0n);
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count, 0n);
    } finally {
      item.connection.close();
    }
  });

  it("requires trusted primary bindings, exact project assertions, and command-specific authorization", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const item = fixture(Processor);
    try {
      const primary = context("primary-gates");
      const initial = preparedStart(primary, startCommand(107, "binding-gates"));
      for (const [label, projectContext] of [
        ["maintenance", context("maintenance-gates", "maintenance")],
        ["untrusted", context("untrusted-gates", "untrusted")],
        ["workspace alias", {
          ...primary,
          workspace: { ...primary.workspace },
        } as ProjectContext],
      ] as const) {
        assert.throws(
          () => item.processor.startRoot(projectContext, preparedStart(
            projectContext,
            startCommand(108, `binding-${label}`),
          )),
          (error: unknown) => (error as { code?: string }).code === "PROJECT_BINDING_REQUIRED",
          label,
        );
      }
      for (const [label, command] of [
        ["project", {
          ...startCommand(109),
          expectedProjectId: lifecycleUuid(900) as RootStartCommandV2["expectedProjectId"],
        }],
        ["vault", {
          ...startCommand(110),
          expectedVaultId: lifecycleUuid(901) as RootStartCommandV2["expectedVaultId"],
        }],
        ["workspace", {
          ...startCommand(111),
          expectedWorkspaceId: "a".repeat(64) as RootStartCommandV2["expectedWorkspaceId"],
        }],
      ] as const) {
        const valid = preparedStart(primary, startCommand(Number(command.commandId.slice(-12))));
        assert.throws(
          () => item.processor.startRoot(primary, { ...valid, command }),
          (error: unknown) => (error as { code?: string }).code === "PROJECT_BINDING_REQUIRED",
          label,
        );
      }
      const wrongBranch = { ...startCommand(112), expectedBranchRef: "refs/heads/other" };
      assert.throws(
        () => item.processor.startRoot(primary, preparedStart(primary, wrongBranch)),
        (error: unknown) => (error as { code?: string }).code === "WORKSPACE_AMBIGUOUS",
      );
      const wrongStartAuthorization: PreparedLifecycleWorkerCommand<RootStartCommandV2> = {
        ...initial,
        authorization: {
          kind: "protected",
          authoritySessionId: lifecycleUuid(910),
          targetSessionId: lifecycleUuid(910),
          proof: {
            proofVersion: 1,
            target: "semantic-command",
            proofNonce: lifecycleUuid(911),
            proofFingerprint: "1".repeat(64),
          },
          approval: null,
          childBindingGrant: null,
        },
      };
      assert.throws(
        () => item.processor.startRoot(primary, wrongStartAuthorization),
        (error: unknown) => (error as { code?: string }).code === "SESSION_CAPABILITY_INVALID",
      );

      const started = success(item.processor.startRoot(primary, initial));
      const resumeCommandValue = resumeCommand(113, started.publicResult.sessionId, "1");
      const resume = preparedResume(item, primary, started, resumeCommandValue);
      const suspendCommandValue = suspendCommand(114, started.publicResult.sessionId, "1");
      const suspend = preparedSuspend(item, primary, started, suspendCommandValue);
      for (const actorRole of ["maintenance", "untrusted"] as const) {
        const caller = context(`${actorRole}-semantic-gate`, actorRole);
        assert.throws(
          () => item.processor.resumeRoot(
            caller,
            preparedResume(item, caller, started, resumeCommandValue),
          ),
          (error: unknown) => (error as { code?: string }).code === "PROJECT_BINDING_REQUIRED",
        );
        assert.throws(
          () => item.processor.suspendRoot(
            caller,
            preparedSuspend(item, caller, started, suspendCommandValue),
          ),
          (error: unknown) => (error as { code?: string }).code === "PROJECT_BINDING_REQUIRED",
        );
      }
      const initialAuthorization = {
        kind: "initial-authority" as const,
        authoritySessionId: null,
        targetSessionId: null,
        proof: null,
        approval: null,
        childBindingGrant: null,
      };
      assert.throws(
        () => item.processor.resumeRoot(primary, {
          ...resume,
          authorization: initialAuthorization,
        }),
        (error: unknown) => (error as { code?: string }).code === "SESSION_CAPABILITY_INVALID",
      );
      assert.throws(
        () => item.processor.suspendRoot(primary, {
          ...suspend,
          authorization: initialAuthorization,
        }),
        (error: unknown) => (error as { code?: string }).code === "SESSION_CAPABILITY_INVALID",
      );
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 1n);
    } finally {
      item.connection.close();
    }
  });
});

describe("LifecycleCommandProcessor root resume", () => {
  it("blocks a live foreign owner, transfers at exact expiry, and fences old authority", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const item = fixture(Processor);
    try {
      const firstContext = context("primary-1");
      const started = success(item.processor.startRoot(
        firstContext,
        preparedStart(firstContext, startCommand(110)),
      ));
      const targetContext = context("primary-2");
      const transferInput = preparedResume(
        item,
        targetContext,
        started,
        resumeCommand(111, started.publicResult.sessionId, "1"),
      );
      const staleContext = context("primary-3");
      const staleInput = preparedResume(
        item,
        staleContext,
        started,
        resumeCommand(112, started.publicResult.sessionId, "1"),
      );
      assert.equal(transferInput.authorization.kind, "protected");
      assert.ok(transferInput.authorization.proof !== null);
      const badCurrentProof: PreparedLifecycleWorkerCommand<RootResumeCommandV2> = {
        ...transferInput,
        authorization: {
          ...transferInput.authorization,
          proof: {
            ...transferInput.authorization.proof,
            proofFingerprint: "d".repeat(64),
          },
        },
      };
      item.selectionTrace.length = 0;
      assert.throws(
        () => item.processor.resumeRoot(targetContext, badCurrentProof),
        (error: unknown) => (error as { code?: string }).code === "SESSION_CAPABILITY_INVALID",
      );
      assert.deepEqual(item.selectionTrace, ["candidate-query", "fold", "proof"]);

      assert.throws(
        () => item.processor.resumeRoot(targetContext, transferInput),
        (error: unknown) => (error as { code?: string }).code === "SESSION_ALREADY_OWNED",
      );
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 1n);

      const generationOne = item.leases.current(
        item.connection,
        PROJECT_ID,
        started.publicResult.sessionId,
      );
      assert.ok(generationOne !== null);
      seedRootCheckpoint(item, started.publicResult.sessionId, 20_001);
      item.clock.now = generationOne.expiresAtMs;
      const transferred = success(item.processor.resumeRoot(targetContext, transferInput));
      assert.equal(transferred.publicResult.ownerGeneration, "2");
      assert.equal(transferred.publicResult.resumedFromSessionId, started.publicResult.sessionId);
      assert.equal(transferred.authorityMaterial.target?.clientInstanceId, "primary-2");
      const current = item.authority.get(
        item.connection,
        PROJECT_ID,
        started.publicResult.sessionId,
      );
      assert.ok(current !== null);
      assert.equal(current.ownerGeneration, 2n);
      assert.equal(current.rootHandleClientInstanceId, "primary-2");
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 3n);
      const leaseRows = item.connection.prepare(`
        SELECT owner_generation, released_at FROM session_leases ORDER BY owner_generation
      `).all();
      assert.deepEqual(leaseRows.map((row) => [row.owner_generation, row.released_at !== null]), [
        [1n, true],
        [2n, false],
      ]);

      item.selectionTrace.length = 0;
      const staleEffectsBefore = [
        item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM session_leases").get()?.count,
      ];
      assert.throws(
        () => item.processor.resumeRoot(staleContext, staleInput),
        (error: unknown) => (error as { code?: string }).code === "SESSION_HANDLE_STALE",
      );
      assert.deepEqual(item.selectionTrace, ["candidate-query", "fold", "proof"]);
      assert.deepEqual([
        item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM session_leases").get()?.count,
      ], staleEffectsBefore);
    } finally {
      item.connection.close();
    }
  });

  it("rejects a resume when the current lease owner mirror disagrees with root authority", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    let corruptLease = false;
    const item = fixture(Processor, {
      currentLease: (actual) => corruptLease && actual !== null
        ? Object.freeze({ ...actual, ownerClientInstanceId: "forged-lease-owner" })
        : actual,
    });
    try {
      const source = context("primary-resume-lease-source");
      const started = success(item.processor.startRoot(
        source,
        preparedStart(source, startCommand(750, "resume-lease-owner")),
      ));
      const target = context("primary-resume-lease-target");
      const prepared = preparedResume(
        item,
        target,
        started,
        resumeCommand(751, started.publicResult.sessionId, "1", null, "exact"),
      );
      const lease = item.leases.current(
        item.connection,
        PROJECT_ID,
        started.publicResult.sessionId,
      );
      assert.ok(lease !== null);
      item.clock.now = lease.expiresAtMs;
      corruptLease = true;
      const effectsBefore = [
        item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM session_leases").get()?.count,
      ];
      item.selectionTrace.length = 0;
      item.operationTrace.length = 0;

      assert.throws(
        () => item.processor.resumeRoot(target, prepared),
        (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
      );

      assert.deepEqual(item.selectionTrace, [
        "candidate-query",
        "fold",
        "proof",
        "lease-current",
      ]);
      assert.deepEqual(item.operationTrace, []);
      assert.deepEqual([
        item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM session_leases").get()?.count,
      ], effectsBefore);
    } finally {
      item.connection.close();
    }
  });

  it("replays lost start and resume responses before consulting current authority", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const item = fixture(Processor);
    try {
      const firstContext = context("primary-1");
      const startInput = preparedStart(firstContext, startCommand(120));
      const started = success(item.processor.startRoot(firstContext, startInput));
      const startReplay = success(item.processor.startRoot(firstContext, startInput));
      assert.deepEqual(startReplay.publicResult, started.publicResult);
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 1n);

      const secondContext = context("primary-2");
      const resumeInput = preparedResume(
        item,
        secondContext,
        started,
        resumeCommand(121, started.publicResult.sessionId, "1"),
      );
      const lease = item.leases.current(item.connection, PROJECT_ID, started.publicResult.sessionId);
      assert.ok(lease !== null);
      seedRootCheckpoint(item, started.publicResult.sessionId, 20_010);
      item.clock.now = lease.expiresAtMs;
      const resumed = success(item.processor.resumeRoot(secondContext, resumeInput));
      const replay = success(item.processor.resumeRoot(secondContext, resumeInput));
      assert.deepEqual(replay.publicResult, resumed.publicResult);
      assert.equal(replay.authorityMaterial.status, "current");
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 3n);

      const thirdContext = context("primary-3");
      const nextInput = preparedResume(
        item,
        thirdContext,
        resumed,
        resumeCommand(122, resumed.publicResult.sessionId, "2"),
      );
      const currentLease = item.leases.current(item.connection, PROJECT_ID, resumed.publicResult.sessionId);
      assert.ok(currentLease !== null);
      seedRootCheckpoint(item, resumed.publicResult.sessionId, 20_012);
      item.clock.now = currentLease.expiresAtMs;
      const third = success(item.processor.resumeRoot(thirdContext, nextInput));
      assert.equal(third.publicResult.ownerGeneration, "3");

      const staleReplay = success(item.processor.resumeRoot(secondContext, resumeInput));
      assert.deepEqual(staleReplay.publicResult, resumed.publicResult);
      assert.equal(staleReplay.authorityMaterial.status, "stale");
      assert.equal(staleReplay.authorityMaterial.descriptor, null);
      assert.equal(staleReplay.authorityMaterial.recoveryCode, "SESSION_HANDLE_STALE");
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 5n);
    } finally {
      item.connection.close();
    }
  });

  it("resolves exact ownership by either explicit session or exact namespaced continuity", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);

    const bySession = fixture(Processor);
    try {
      const source = context("primary-1");
      const started = success(bySession.processor.startRoot(
        source,
        preparedStart(source, startCommand(123, "exact-session-thread")),
      ));
      const target = context("primary-2");
      const command = resumeCommand(
        124,
        started.publicResult.sessionId,
        "1",
        null,
        "exact",
      );
      const prepared = preparedResume(bySession, target, started, command);
      const lease = bySession.leases.current(bySession.connection, PROJECT_ID, started.publicResult.sessionId);
      assert.ok(lease !== null);
      seedRootCheckpoint(bySession, started.publicResult.sessionId, 20_020);
      bySession.clock.now = lease.expiresAtMs;
      const resumed = success(bySession.processor.resumeRoot(target, prepared));
      assert.equal(resumed.publicResult.sessionId, started.publicResult.sessionId);
      assert.equal(resumed.publicResult.ownerGeneration, "2");
    } finally {
      bySession.connection.close();
    }

    const byContinuity = fixture(Processor);
    try {
      const source = context("primary-1");
      const started = success(byContinuity.processor.startRoot(
        source,
        preparedStart(source, startCommand(150, "exact-continuity-thread")),
      ));
      const target = context("primary-2");
      const command = resumeCommand(151, null, "1", "exact-continuity-thread", "exact");
      const prepared = preparedResume(byContinuity, target, started, command);
      const lease = byContinuity.leases.current(
        byContinuity.connection,
        PROJECT_ID,
        started.publicResult.sessionId,
      );
      assert.ok(lease !== null);
      seedRootCheckpoint(byContinuity, started.publicResult.sessionId, 20_022);
      byContinuity.clock.now = lease.expiresAtMs;
      const resumed = success(byContinuity.processor.resumeRoot(target, prepared));
      assert.equal(resumed.publicResult.sessionId, started.publicResult.sessionId);
      assert.equal(resumed.publicResult.ownerGeneration, "2");
    } finally {
      byContinuity.connection.close();
    }
  });

  it("replays current-generation authority and rejects a fresh same-owner command without a synthetic event", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const item = fixture(Processor);
    try {
      const primary = context("primary-1");
      const started = success(item.processor.startRoot(
        primary,
        preparedStart(primary, startCommand(152, "same-owner-thread")),
      ));
      const leaseBefore = item.leases.current(item.connection, PROJECT_ID, started.publicResult.sessionId);
      assert.ok(leaseBefore !== null);
      const eventCount = item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count;
      const dedupCount = item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count;
      assert.throws(
        () => item.processor.resumeRoot(
          primary,
          preparedResume(
            item,
            primary,
            started,
            resumeCommand(153, started.publicResult.sessionId, "1", null, "exact"),
          ),
        ),
        (error: unknown) => (error as { code?: string }).code === "SESSION_ALREADY_OWNED",
      );
      const replayed = success(item.processor.startRoot(
        primary,
        preparedStart(primary, startCommand(152, "same-owner-thread")),
      ));
      assert.deepEqual(replayed.publicResult, started.publicResult);
      assert.equal(replayed.authorityMaterial.status, "current");
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, eventCount);
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count, dedupCount);
      assert.deepEqual(item.leases.current(item.connection, PROJECT_ID, started.publicResult.sessionId), leaseBefore);
    } finally {
      item.connection.close();
    }
  });

  it("uses latest-safe exact filters, reports zero or multiple before proof, and never tie-breaks", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    let forcedCandidates: readonly SessionAuthorityRecord[] | null = null;
    const item = fixture(Processor, {
      resumeCandidates: (_input, actual) => forcedCandidates ?? actual,
    });
    try {
      const firstContext = context("primary-1");
      const first = success(item.processor.startRoot(
        firstContext,
        preparedStart(firstContext, startCommand(154, "latest-safe-a")),
      ));
      const firstSuspended = success(item.processor.suspendRoot(
        firstContext,
        preparedSuspend(
          item,
          firstContext,
          first,
          suspendCommand(1_154, first.publicResult.sessionId, "1"),
        ),
      ));
      item.clock.now += 1_000n;
      const secondContext = context("primary-2");
      const second = success(item.processor.startRoot(
        secondContext,
        preparedStart(secondContext, startCommand(155, "latest-safe-b")),
      ));
      const secondSuspended = success(item.processor.suspendRoot(
        secondContext,
        preparedSuspend(
          item,
          secondContext,
          second,
          suspendCommand(1_155, second.publicResult.sessionId, "1"),
        ),
      ));

      const target = context("primary-3");
      item.selectionTrace.length = 0;
      const zero = preparedResume(
        item,
        target,
        first,
        resumeCommand(156, null, "1", "missing-latest-safe", "latest-safe"),
      );
      assert.throws(
        () => item.processor.resumeRoot(target, zero),
        (error: unknown) => (error as { code?: string }).code === "SESSION_NOT_FOUND",
      );
      assert.deepEqual(item.selectionTrace, ["candidate-query"]);

      const firstAuthority = item.authority.get(item.connection, PROJECT_ID, first.publicResult.sessionId);
      const secondAuthority = item.authority.get(item.connection, PROJECT_ID, second.publicResult.sessionId);
      assert.ok(firstAuthority !== null && secondAuthority !== null);
      forcedCandidates = [secondAuthority, firstAuthority];
      item.selectionTrace.length = 0;
      const validAmbiguous = preparedResume(
        item,
        target,
        firstSuspended,
        resumeCommand(157, null, "1", null, "latest-safe"),
      );
      assert.equal(validAmbiguous.authorization.kind, "protected");
      assert.ok(validAmbiguous.authorization.proof !== null);
      const ambiguous: PreparedLifecycleWorkerCommand<RootResumeCommandV2> = {
        ...validAmbiguous,
        authorization: {
          ...validAmbiguous.authorization,
          proof: {
            ...validAmbiguous.authorization.proof,
            proofFingerprint: "c".repeat(64),
          },
        },
      };
      const countsBefore = [
        item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
      ];
      let ambiguity: unknown;
      try {
        item.processor.resumeRoot(target, ambiguous);
        assert.fail("latest-safe must not tie-break multiple compatible roots");
      } catch (error) {
        ambiguity = error;
      }
      assert.equal((ambiguity as { code?: string }).code, "SESSION_AMBIGUOUS");
      assert.deepEqual(
        (ambiguity as { candidateSummaries?: unknown }).candidateSummaries,
        {
          schemaVersion: 1,
          candidates: [firstAuthority, secondAuthority]
            .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
            .map((candidate) => ({
              sessionId: candidate.sessionId,
              state: "suspended",
              ownerGeneration: "1",
              latestCheckpointEventPosition: candidate.latestCheckpointEventPosition?.toString() ?? null,
              checkpointRequired: true,
            })),
          truncated: false,
        },
      );
      assert.deepEqual(item.selectionTrace, [
        "candidate-query",
        "checkpoint",
        "checkpoint",
        "fold",
        "fold",
        "source-capture",
      ]);
      assert.ok(secondSuspended.publicResult.latestCheckpointEventPosition !== null);
      assert.deepEqual([
        item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
      ], countsBefore);
    } finally {
      item.connection.close();
    }
  });

  it("applies every latest-safe filter in the approved order before target, proof, generation, or lease", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    let forcedCandidates: readonly SessionAuthorityRecord[] = [];
    let sourceMismatch = false;
    const item = fixture(Processor, {
      resumeCandidates: () => forcedCandidates,
      resumeSourceState: (projectContext) => {
        const source = checkpointSourceState(projectContext);
        return sourceMismatch
          ? Object.freeze({ ...source, dirtyWorktreeFingerprint: "d".repeat(64) })
          : source;
      },
    });
    try {
      const firstContext = context("primary-filter-1");
      const first = success(item.processor.startRoot(
        firstContext,
        preparedStart(firstContext, startCommand(300, "filter-first")),
      ));
      const firstSuspended = success(item.processor.suspendRoot(
        firstContext,
        preparedSuspend(
          item,
          firstContext,
          first,
          suspendCommand(301, first.publicResult.sessionId, "1"),
        ),
      ));
      const secondContext = context("primary-filter-2");
      const second = success(item.processor.startRoot(
        secondContext,
        preparedStart(secondContext, startCommand(302, "filter-second")),
      ));
      const secondSuspended = success(item.processor.suspendRoot(
        secondContext,
        preparedSuspend(
          item,
          secondContext,
          second,
          suspendCommand(303, second.publicResult.sessionId, "1"),
        ),
      ));
      const activeContext = context("primary-filter-active");
      const active = success(item.processor.startRoot(
        activeContext,
        preparedStart(activeContext, startCommand(304, "filter-active")),
      ));
      const firstAuthority = item.authority.get(
        item.connection,
        PROJECT_ID,
        first.publicResult.sessionId,
      );
      const secondAuthority = item.authority.get(
        item.connection,
        PROJECT_ID,
        second.publicResult.sessionId,
      );
      const activeAuthority = item.authority.get(
        item.connection,
        PROJECT_ID,
        active.publicResult.sessionId,
      );
      assert.ok(firstAuthority !== null && secondAuthority !== null && activeAuthority !== null);

      const target = context("primary-filter-target");
      let ordinal = 310;
      const unchangedCounts = () => [
        item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM session_leases").get()?.count,
      ];
      const reject = (
        label: string,
        candidate: SessionAuthorityRecord,
        command: RootResumeCommandV2,
        issued: Extract<WorkerLifecycleResult<RootSessionPublicResultV2>, { kind: "success" }>,
        projectContext: ProjectContext,
        expectedCode: string,
        expectedTrace: readonly string[],
      ): void => {
        forcedCandidates = [candidate];
        const prepared = preparedResume(item, projectContext, issued, command);
        const before = unchangedCounts();
        item.selectionTrace.length = 0;
        item.operationTrace.length = 0;
        assert.throws(
          () => item.processor.resumeRoot(projectContext, prepared),
          (error: unknown) => {
            assert.equal((error as { code?: string }).code, expectedCode, label);
            return true;
          },
        );
        assert.deepEqual(item.selectionTrace, expectedTrace, label);
        assert.deepEqual(item.operationTrace, [], label);
        assert.deepEqual(unchangedCounts(), before, label);
      };
      const latest = (
        continuityKey: string | null = null,
        sessionId: string | null = null,
        branchRef: string | null = null,
      ): RootResumeCommandV2 => ({
        ...resumeCommand(ordinal++, sessionId, "1", continuityKey, "latest-safe"),
        expectedBranchRef: branchRef,
      });

      reject(
        "optional session",
        firstAuthority,
        latest(null, second.publicResult.sessionId),
        secondSuspended,
        target,
        "SESSION_NOT_FOUND",
        ["candidate-query"],
      );
      reject(
        "exact continuity",
        firstAuthority,
        latest("different-continuity"),
        firstSuspended,
        target,
        "SESSION_NOT_FOUND",
        ["candidate-query"],
      );
      reject(
        "project identity",
        { ...firstAuthority, projectId: lifecycleUuid(899) },
        latest(),
        firstSuspended,
        target,
        "SESSION_NOT_FOUND",
        ["candidate-query"],
      );
      reject(
        "client namespace",
        { ...firstAuthority, clientNamespace: "desktop/other" },
        latest(),
        firstSuspended,
        target,
        "SESSION_NOT_FOUND",
        ["candidate-query"],
      );
      reject(
        "workspace visibility",
        { ...firstAuthority, workspaceId: "e".repeat(64) },
        latest(),
        firstSuspended,
        target,
        "SESSION_NOT_FOUND",
        ["candidate-query"],
      );

      for (const [label, candidate] of [
        ["child", { ...firstAuthority, sessionKind: "child" as const }],
        ["terminal", { ...firstAuthority, terminalEventPosition: 4n }],
        ["ending", { ...firstAuthority, semanticState: "ending" as const }],
        ["missing owner generation", { ...firstAuthority, ownerGeneration: null }],
      ] as const) {
        reject(
          label,
          candidate,
          latest(),
          firstSuspended,
          target,
          "SESSION_NOT_FOUND",
          ["candidate-query", "checkpoint"],
        );
      }
      reject(
        "fold mirror mismatch",
        { ...firstAuthority, authorityCommitment: "9".repeat(64) },
        latest(),
        firstSuspended,
        target,
        "INTEGRITY_FAILURE",
        ["candidate-query", "checkpoint", "fold"],
      );
      reject(
        "missing checkpoint",
        activeAuthority,
        latest(),
        firstSuspended,
        target,
        "SESSION_NOT_FOUND",
        ["candidate-query", "checkpoint", "fold"],
      );
      const gitTarget = gitContext("primary-filter-git");
      reject(
        "branch visibility",
        firstAuthority,
        latest(null, null, "refs/heads/main"),
        firstSuspended,
        gitTarget,
        "SESSION_NOT_FOUND",
        ["candidate-query", "checkpoint"],
      );
      sourceMismatch = true;
      reject(
        "full current source witness",
        firstAuthority,
        latest(),
        firstSuspended,
        target,
        "SESSION_NOT_FOUND",
        ["candidate-query", "checkpoint", "fold", "source-capture"],
      );
      sourceMismatch = false;
      reject(
        "candidate target binding",
        secondAuthority,
        latest(),
        firstSuspended,
        target,
        "SESSION_OWNERSHIP_MISMATCH",
        ["candidate-query", "checkpoint", "fold", "source-capture"],
      );
    } finally {
      item.connection.close();
    }
  });

  it("resumes one latest-safe compatible root only after exhausting the keyset and transfers once", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const item = fixture(Processor);
    try {
      const source = context("primary-latest-source");
      const started = success(item.processor.startRoot(
        source,
        preparedStart(source, startCommand(340, "latest-safe-unique")),
      ));
      const suspended = success(item.processor.suspendRoot(
        source,
        preparedSuspend(
          item,
          source,
          started,
          suspendCommand(341, started.publicResult.sessionId, "1"),
        ),
      ));
      seedRootCheckpoint(item, started.publicResult.sessionId, 20_030);
      const target = context("primary-latest-target");
      const command = resumeCommand(342, null, "1", null, "latest-safe");
      const prepared = preparedResume(item, target, suspended, command);
      const lease = item.leases.current(item.connection, PROJECT_ID, started.publicResult.sessionId);
      assert.ok(lease !== null);
      item.clock.now = lease.expiresAtMs;
      item.selectionTrace.length = 0;
      item.operationTrace.length = 0;

      const resumed = success(item.processor.resumeRoot(target, prepared));

      assert.equal(resumed.publicResult.ownerGeneration, "2");
      assert.equal(resumed.publicResult.state, "active");
      assert.deepEqual(item.selectionTrace, [
        "candidate-query",
        "checkpoint",
        "fold",
        "source-capture",
        "proof",
        "lease-current",
        "lease-expiry",
        "checkpoint",
      ]);
      assert.deepEqual(item.operationTrace, [
        "children-list",
        "lease-release/1",
        "authority-cas/2",
        "lease-insert/2",
      ]);
      assert.deepEqual(item.connection.prepare(`
        SELECT event_type FROM events ORDER BY global_position
      `).all().slice(-2).map((row) => row.event_type), [
        "SessionOwnerTransferred",
        "SessionResumed",
      ]);
      const current = item.authority.get(item.connection, PROJECT_ID, started.publicResult.sessionId);
      assert.ok(current !== null);
      assert.equal(current.checkpointRequiredReason, "ownership-transfer");
      assert.equal(current.checkpointRequiredEventPosition, current.authorityEventPosition);
    } finally {
      item.connection.close();
    }
  });

  it("rolls back release, CAS, lease insertion, and partial append for active and suspended resume", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    for (const priorState of ["active", "suspended"] as const) {
      let failAppend = false;
      const item = fixture(Processor, {
        eventFault: (boundary) => {
          if (failAppend && boundary === "after-first-insert-before-commit") {
            throw new Error(`injected-${priorState}-resume-append-failure`);
          }
        },
      });
      try {
        const source = context(`primary-rollback-${priorState}`);
        const started = success(item.processor.startRoot(
          source,
          preparedStart(source, startCommand(350, `rollback-${priorState}`)),
        ));
        const issued = priorState === "suspended"
          ? success(item.processor.suspendRoot(
              source,
              preparedSuspend(
                item,
                source,
                started,
                suspendCommand(351, started.publicResult.sessionId, "1"),
              ),
            ))
          : started;
        seedRootCheckpoint(
          item,
          issued.publicResult.sessionId,
          priorState === "active" ? 20_040 : 20_042,
        );
        const target = context(`primary-rollback-target-${priorState}`);
        const prepared = preparedResume(
          item,
          target,
          issued,
          resumeCommand(352, issued.publicResult.sessionId, "1", null, "exact"),
        );
        const lease = item.leases.current(item.connection, PROJECT_ID, issued.publicResult.sessionId);
        const authorityBefore = item.authority.get(
          item.connection,
          PROJECT_ID,
          issued.publicResult.sessionId,
        );
        assert.ok(lease !== null && authorityBefore !== null);
        item.clock.now = lease.expiresAtMs;
        const effectsBefore = [
          item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
          item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
          item.connection.prepare("SELECT COUNT(*) AS count FROM session_leases").get()?.count,
        ];
        const leaseRowsBefore = item.connection.prepare(`
          SELECT owner_generation, owner_client_instance_id, released_at
          FROM session_leases ORDER BY owner_generation
        `).all();
        item.operationTrace.length = 0;
        failAppend = true;

        assert.throws(
          () => item.processor.resumeRoot(target, prepared),
          new RegExp(`injected-${priorState}-resume-append-failure`, "u"),
        );

        assert.deepEqual(item.operationTrace, [
          "children-list",
          "lease-release/1",
          "authority-cas/2",
          "lease-insert/2",
        ]);
        assert.deepEqual(
          item.authority.get(item.connection, PROJECT_ID, issued.publicResult.sessionId),
          authorityBefore,
        );
        assert.deepEqual(item.connection.prepare(`
          SELECT owner_generation, owner_client_instance_id, released_at
          FROM session_leases ORDER BY owner_generation
        `).all(), leaseRowsBefore);
        assert.deepEqual([
          item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
          item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
          item.connection.prepare("SELECT COUNT(*) AS count FROM session_leases").get()?.count,
        ], effectsBefore);
        assert.deepEqual(item.connection.transactionStatements.slice(-2), [
          "BEGIN IMMEDIATE",
          "ROLLBACK",
        ]);

        failAppend = false;
        const retried = success(item.processor.resumeRoot(target, prepared));
        assert.equal(retried.publicResult.ownerGeneration, "2");
        assert.equal(retried.publicResult.state, "active");
      } finally {
        item.connection.close();
      }
    }
  });

  it("pages past 17 early incompatible roots and bounds later compatible ambiguity without tie-breaking", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const item = fixture(Processor);
    try {
      const suspendNewRoot = (
        commandOrdinal: number,
        clientInstanceId: string,
        continuityKey: string,
        fingerprint = "f".repeat(64),
      ): Extract<WorkerLifecycleResult<RootSessionPublicResultV2>, { kind: "success" }> => {
        const owner = context(clientInstanceId, "primary", NOW, fingerprint);
        const started = success(item.processor.startRoot(
          owner,
          preparedStart(owner, startCommand(commandOrdinal, continuityKey)),
        ));
        return success(item.processor.suspendRoot(
          owner,
          preparedSuspend(
            item,
            owner,
            started,
            suspendCommand(commandOrdinal + 1, started.publicResult.sessionId, "1"),
          ),
        ));
      };

      for (let index = 0; index < 17; index += 1) {
        suspendNewRoot(
          400 + index * 2,
          `primary-incompatible-${index}`,
          `paging-incompatible-canary-${index}`,
          "e".repeat(64),
        );
      }
      const firstCompatible = suspendNewRoot(
        500,
        "primary-compatible-0",
        "paging-compatible-canary-0",
      );
      seedRootCheckpoint(item, firstCompatible.publicResult.sessionId, 20_050);
      const uniqueTarget = context("primary-paging-unique");
      const uniqueCommand = resumeCommand(502, null, "1", null, "latest-safe");
      const uniquePrepared = preparedResume(
        item,
        uniqueTarget,
        firstCompatible,
        uniqueCommand,
      );
      const uniqueLease = item.leases.current(
        item.connection,
        PROJECT_ID,
        firstCompatible.publicResult.sessionId,
      );
      assert.ok(uniqueLease !== null);
      item.clock.now = uniqueLease.expiresAtMs;
      item.selectionTrace.length = 0;
      const unique = success(item.processor.resumeRoot(uniqueTarget, uniquePrepared));
      assert.equal(unique.publicResult.ownerGeneration, "2");
      assert.equal(
        item.selectionTrace.filter((entry) => entry === "candidate-query").length,
        2,
      );

      const secondCompatible = suspendNewRoot(
        504,
        "primary-compatible-1",
        "paging-compatible-canary-1",
      );
      const ambiguousTarget = context("primary-paging-ambiguous");
      const ambiguousPrepared = preparedResume(
        item,
        ambiguousTarget,
        secondCompatible,
        resumeCommand(506, null, "1", null, "latest-safe"),
      );
      item.selectionTrace.length = 0;
      assert.throws(
        () => item.processor.resumeRoot(ambiguousTarget, ambiguousPrepared),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "SESSION_AMBIGUOUS");
          assert.equal(
            (error as { candidateSummaries?: { candidates?: readonly unknown[] } })
              .candidateSummaries?.candidates?.length,
            2,
          );
          return true;
        },
      );
      assert.equal(
        item.selectionTrace.filter((entry) => entry === "candidate-query").length,
        2,
      );
      assert.equal(item.selectionTrace.includes("proof"), false);
      assert.equal(item.selectionTrace.includes("lease-current"), false);

      for (let index = 2; index < 17; index += 1) {
        suspendNewRoot(
          510 + index * 2,
          `primary-compatible-${index}`,
          `paging-compatible-canary-${index}`,
        );
      }
      const finalIssued = suspendNewRoot(
        600,
        "primary-compatible-proof",
        "paging-compatible-proof-canary",
        "e".repeat(64),
      );
      const boundedTarget = context("primary-paging-bounded");
      const boundedPrepared = preparedResume(
        item,
        boundedTarget,
        finalIssued,
        resumeCommand(602, null, "1", null, "latest-safe"),
      );
      item.selectionTrace.length = 0;
      let boundedError: unknown;
      try {
        item.processor.resumeRoot(boundedTarget, boundedPrepared);
        assert.fail("17 compatible roots must remain ambiguous");
      } catch (error) {
        boundedError = error;
      }
      assert.equal((boundedError as { code?: string }).code, "SESSION_AMBIGUOUS");
      const summaries = (boundedError as {
        candidateSummaries?: {
          readonly candidates: readonly { readonly sessionId: string }[];
          readonly truncated: boolean;
        };
        details?: Readonly<Record<string, unknown>>;
      }).candidateSummaries;
      assert.ok(summaries !== undefined);
      assert.equal(summaries.candidates.length, 16);
      assert.equal(summaries.truncated, true);
      assert.deepEqual(
        [...summaries.candidates].map((candidate) => candidate.sessionId),
        [...summaries.candidates].map((candidate) => candidate.sessionId).sort(),
      );
      const details = (boundedError as { details: Readonly<Record<string, unknown>> }).details;
      assert.equal(Object.isFrozen(details), true);
      assert.equal(Object.prototype.propertyIsEnumerable.call(boundedError, "details"), false);
      assert.ok(Buffer.byteLength(String(details.candidateSummariesJson), "utf8") <= 16_384);
      assert.doesNotMatch(
        JSON.stringify((boundedError as { toJSON(): unknown }).toJSON()),
        /paging-(?:incompatible|compatible).*canary/iu,
      );
      assert.equal(item.selectionTrace.includes("proof"), false);
      assert.equal(item.selectionTrace.includes("lease-current"), false);
    } finally {
      item.connection.close();
    }
  });
});

describe("LifecycleCommandProcessor root lease renewal", () => {
  it("verifies a bounded proof, clamps backward time, and renews after nominal expiry without events", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const item = fixture(Processor);
    try {
      const primary = context("primary-1");
      const started = success(item.processor.startRoot(
        primary,
        preparedStart(primary, startCommand(125, "heartbeat-thread")),
      ));
      item.clock.now = NOW_MS + 40_000n;
      item.processor.renewRootLease(
        primary,
        renewalOperation(item, primary, started, 126),
      );
      let lease = item.leases.current(item.connection, PROJECT_ID, started.publicResult.sessionId);
      assert.ok(lease !== null);
      assert.equal(lease.lastObservedAtMs, NOW_MS + 40_000n);
      assert.equal(lease.renewedAtMs, NOW_MS + 40_000n);
      assert.equal(lease.expiresAtMs, NOW_MS + 160_000n);

      item.clock.now = NOW_MS + 20_000n;
      const backwardContext = context(
        "primary-1",
        "primary",
        new Date(Number(item.clock.now)).toISOString(),
      );
      item.processor.renewRootLease(
        backwardContext,
        renewalOperation(item, backwardContext, started, 127),
      );
      lease = item.leases.current(item.connection, PROJECT_ID, started.publicResult.sessionId);
      assert.ok(lease !== null);
      assert.equal(lease.lastObservedAtMs, NOW_MS + 40_000n);
      assert.equal(lease.expiresAtMs, NOW_MS + 160_000n);

      item.clock.now = lease.expiresAtMs;
      const expiredContext = context(
        "primary-1",
        "primary",
        new Date(Number(item.clock.now)).toISOString(),
      );
      item.processor.renewRootLease(
        expiredContext,
        renewalOperation(item, expiredContext, started, 128),
      );
      const renewedAfterExpiry = item.leases.current(
        item.connection,
        PROJECT_ID,
        started.publicResult.sessionId,
      );
      assert.ok(renewedAfterExpiry !== null);
      assert.equal(renewedAfterExpiry.lastObservedAtMs, NOW_MS + 160_000n);
      assert.equal(renewedAfterExpiry.expiresAtMs, NOW_MS + 280_000n);
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 1n);
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count, 1n);
    } finally {
      item.connection.close();
    }
  });

  it("rejects expired proofs and every reconstructed tuple tamper without effects", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const item = fixture(Processor);
    try {
      const primary = context("primary-1");
      const started = success(item.processor.startRoot(
        primary,
        preparedStart(primary, startCommand(129, "heartbeat-negative-thread")),
      ));
      const originalLease = item.leases.current(
        item.connection,
        PROJECT_ID,
        started.publicResult.sessionId,
      );
      assert.ok(originalLease !== null);
      const eventCount = item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count;
      const dedupCount = item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count;

      const reject = (
        operation: Extract<BoundedLifecycleOperation, { operation: "renew-root-lease" }>,
        code: string,
        transactionExpected: boolean,
      ): void => {
        const transactionOffset = item.connection.transactionStatements.length;
        assert.throws(
          () => item.processor.renewRootLease(primary, operation),
          (error: unknown) => (error as { code?: string }).code === code,
        );
        assert.deepEqual(
          item.connection.transactionStatements.slice(transactionOffset),
          transactionExpected ? ["BEGIN IMMEDIATE", "ROLLBACK"] : [],
        );
        assert.deepEqual(
          item.leases.current(item.connection, PROJECT_ID, started.publicResult.sessionId),
          originalLease,
        );
        assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, eventCount);
        assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count, dedupCount);
      };

      const expired = renewalOperation(item, primary, started, 130);
      item.clock.now = NOW_MS + OWNER_LEASE_MS;
      reject(expired, "SESSION_CAPABILITY_EXPIRED", true);
      item.clock.now = NOW_MS;

      const validAudience = renewalOperation(item, primary, started, 131);
      reject({
        ...validAudience,
        authorization: {
          ...validAudience.authorization,
          audience: {
            ...validAudience.authorization.audience,
            targetClientInstanceId: "primary-tampered",
          },
        },
      }, "LIFECYCLE_INPUT_INVALID", false);

      const validSession = renewalOperation(item, primary, started, 132);
      reject({
        ...validSession,
        sessionId: lifecycleUuid(90_001) as typeof validSession.sessionId,
      }, "LIFECYCLE_INPUT_INVALID", false);

      reject(
        renewalOperation(item, primary, started, 133, {
          capabilityGeneration: "2",
        }),
        "SESSION_CAPABILITY_INVALID",
        true,
      );

      reject(
        renewalOperation(item, primary, started, 134, {
          operationHash: "0".repeat(64),
        }),
        "SESSION_CAPABILITY_INVALID",
        true,
      );

      const validContext = renewalOperation(item, primary, started, 135);
      reject({
        ...validContext,
        context: {
          ...primary,
          checkedAt: new Date(Number(NOW_MS + 1n)).toISOString(),
        },
      }, "LIFECYCLE_INPUT_INVALID", false);
    } finally {
      item.connection.close();
    }
  });

  it("loses the generation race after takeover and rolls the stale renewal back", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const item = fixture(Processor);
    try {
      const firstContext = context("primary-1");
      const started = success(item.processor.startRoot(
        firstContext,
        preparedStart(firstContext, startCommand(136, "heartbeat-race-thread")),
      ));
      const staleRenewal = renewalOperation(item, firstContext, started, 137);
      const secondContext = context("primary-2");
      const transfer = preparedResume(
        item,
        secondContext,
        started,
        resumeCommand(138, started.publicResult.sessionId, "1", "heartbeat-race-thread"),
      );
      const firstLease = item.leases.current(
        item.connection,
        PROJECT_ID,
        started.publicResult.sessionId,
      );
      assert.ok(firstLease !== null);
      seedRootCheckpoint(item, started.publicResult.sessionId, 20_060);
      item.clock.now = firstLease.expiresAtMs;
      const transferred = success(item.processor.resumeRoot(secondContext, transfer));
      assert.equal(transferred.publicResult.ownerGeneration, "2");
      const generationTwoLease = item.leases.current(
        item.connection,
        PROJECT_ID,
        started.publicResult.sessionId,
      );
      assert.ok(generationTwoLease !== null);
      const eventCount = item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count;
      const dedupCount = item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count;
      const transactionOffset = item.connection.transactionStatements.length;

      assert.throws(
        () => item.processor.renewRootLease(firstContext, staleRenewal),
        (error: unknown) => (error as { code?: string }).code === "SESSION_HANDLE_STALE",
      );
      assert.deepEqual(
        item.connection.transactionStatements.slice(transactionOffset),
        ["BEGIN IMMEDIATE", "ROLLBACK"],
      );
      assert.deepEqual(
        item.leases.current(item.connection, PROJECT_ID, started.publicResult.sessionId),
        generationTwoLease,
      );
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, eventCount);
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count, dedupCount);
    } finally {
      item.connection.close();
    }
  });
});

describe("LifecycleQueryService protected root reads", () => {
  it("returns only bounded allowlisted tree, status, and association summaries without effects", async () => {
    const Processor = await loadProcessorConstructor();
    const QueryService = await loadQueryConstructor();
    assert.ok(Processor !== null);
    assert.ok(QueryService !== null, "LifecycleQueryService must implement protected reads");
    const item = fixture(Processor);
    try {
      const primary = context("primary-1");
      const started = success(item.processor.startRoot(
        primary,
        preparedStart(primary, startCommand(139, "query-thread")),
      ));
      const query = new QueryService({
        connection: item.connection,
        authorityRepository: item.authority,
        capabilityService: item.capabilities,
      });
      const authorityBefore = item.authority.get(
        item.connection,
        PROJECT_ID,
        started.publicResult.sessionId,
      );
      const leaseBefore = item.leases.current(
        item.connection,
        PROJECT_ID,
        started.publicResult.sessionId,
      );
      assert.ok(authorityBefore !== null && leaseBefore !== null);
      const eventCount = item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count;
      const dedupCount = item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count;

      const tree = query.read(
        primary,
        protectedReadOperation(item, primary, started, 140, "read-session-tree"),
      );
      const status = query.read(
        primary,
        protectedReadOperation(item, primary, started, 141, "read-session-status"),
      );
      const association = query.read(
        primary,
        protectedReadOperation(item, primary, started, 142, "read-session-association"),
      );
      const summary = {
        sessionId: started.publicResult.sessionId,
        sessionKind: "root",
        parentSessionId: null,
        state: "active",
        ownerGeneration: "1",
        childCapabilityGeneration: null,
        authorityClientInstanceId: "primary-1",
        directAccessEnabled: false,
        streamVersion: "1",
        eventPosition: "1",
        latestCheckpointEventPosition: null,
        checkpointRequired: false,
      };
      assert.deepEqual(tree, {
        resultVersion: 1,
        operation: "read-session-tree",
        operationId: lifecycleUuid(140),
        requestId: lifecycleUuid(10_140),
        root: summary,
        children: [],
        childrenTruncated: false,
      });
      assert.deepEqual(status, {
        resultVersion: 1,
        operation: "read-session-status",
        operationId: lifecycleUuid(141),
        requestId: lifecycleUuid(10_141),
        session: summary,
      });
      assert.deepEqual(association, {
        resultVersion: 1,
        operation: "read-session-association",
        operationId: lifecycleUuid(142),
        requestId: lifecycleUuid(10_142),
        associated: true,
        sessionId: started.publicResult.sessionId,
        rootSessionId: started.publicResult.sessionId,
      });

      const bannedKeys = new Set([
        "authorityCommitment",
        "continuityFingerprint",
        "proof",
        "proofNonce",
        "proofFingerprint",
        "verifier",
        "rootHandleVerifier",
        "resumeTokenVerifier",
        "childHandleVerifier",
        "approval",
        "payload",
        "events",
        "materials",
      ]);
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const itemValue of value) visit(itemValue);
          return;
        }
        if (typeof value !== "object" || value === null) return;
        for (const [key, itemValue] of Object.entries(value)) {
          assert.equal(bannedKeys.has(key), false, `protected read leaked ${key}`);
          visit(itemValue);
        }
      };
      visit([tree, status, association]);
      assert.deepEqual(
        item.authority.get(item.connection, PROJECT_ID, started.publicResult.sessionId),
        authorityBefore,
      );
      assert.deepEqual(
        item.leases.current(item.connection, PROJECT_ID, started.publicResult.sessionId),
        leaseBefore,
      );
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, eventCount);
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count, dedupCount);
    } finally {
      item.connection.close();
    }
  });

  it("binds proofs to the exact read operation and rejects expiry or stale authority without effects", async () => {
    const Processor = await loadProcessorConstructor();
    const QueryService = await loadQueryConstructor();
    assert.ok(Processor !== null && QueryService !== null);
    const item = fixture(Processor);
    try {
      const primary = context("primary-1");
      const started = success(item.processor.startRoot(
        primary,
        preparedStart(primary, startCommand(143, "query-proof-thread")),
      ));
      const query = new QueryService({
        connection: item.connection,
        authorityRepository: item.authority,
        capabilityService: item.capabilities,
      });
      const originalLease = item.leases.current(
        item.connection,
        PROJECT_ID,
        started.publicResult.sessionId,
      );
      assert.ok(originalLease !== null);
      const counts = (): readonly [bigint, bigint] => [
        item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count as bigint,
        item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count as bigint,
      ];
      const originalCounts = counts();

      const treeProof = protectedReadOperation(item, primary, started, 144, "read-session-tree");
      assert.throws(
        () => query.read(primary, {
          ...treeProof,
          operation: "read-session-status",
        }),
        (error: unknown) => (error as { code?: string }).code === "SESSION_CAPABILITY_INVALID",
      );
      assert.deepEqual(counts(), originalCounts);
      assert.deepEqual(
        item.leases.current(item.connection, PROJECT_ID, started.publicResult.sessionId),
        originalLease,
      );

      const expired = protectedReadOperation(item, primary, started, 145, "read-session-status");
      item.clock.now = NOW_MS + OWNER_LEASE_MS;
      assert.throws(
        () => query.read(primary, expired),
        (error: unknown) => (error as { code?: string }).code === "SESSION_CAPABILITY_EXPIRED",
      );
      assert.deepEqual(counts(), originalCounts);
      assert.deepEqual(
        item.leases.current(item.connection, PROJECT_ID, started.publicResult.sessionId),
        originalLease,
      );

      const stale = protectedReadOperation(item, primary, started, 146, "read-session-association");
      const secondContext = context("primary-2");
      const transfer = preparedResume(
        item,
        secondContext,
        started,
        resumeCommand(147, started.publicResult.sessionId, "1", "query-proof-thread"),
      );
      seedRootCheckpoint(item, started.publicResult.sessionId, 20_062);
      const transferred = success(item.processor.resumeRoot(secondContext, transfer));
      assert.equal(transferred.publicResult.ownerGeneration, "2");
      const postTransferCounts = counts();
      const generationTwoLease = item.leases.current(
        item.connection,
        PROJECT_ID,
        started.publicResult.sessionId,
      );
      assert.ok(generationTwoLease !== null);
      assert.throws(
        () => query.read(primary, stale),
        (error: unknown) => (error as { code?: string }).code === "SESSION_HANDLE_STALE",
      );
      assert.deepEqual(counts(), postTransferCounts);
      assert.deepEqual(
        item.leases.current(item.connection, PROJECT_ID, started.publicResult.sessionId),
        generationTwoLease,
      );
    } finally {
      item.connection.close();
    }
  });

  it("orders and folds exactly the emitted 200 children and reports the 201st as truncation", async () => {
    const Processor = await loadProcessorConstructor();
    const QueryService = await loadQueryConstructor();
    assert.ok(Processor !== null && QueryService !== null);
    const item = fixture(Processor);
    try {
      const primary = context("primary-1");
      const started = success(item.processor.startRoot(
        primary,
        preparedStart(primary, startCommand(148, "query-bound-thread")),
      ));
      const root = item.authority.get(item.connection, PROJECT_ID, started.publicResult.sessionId);
      assert.ok(root !== null);
      const rootFold = item.authority.requireFoldMatch(item.connection, root);
      const children = Array.from({ length: 201 }, (_unused, index) => {
        const sessionId = lifecycleUuid(60_000 + index);
        return {
          ...root,
          sessionId,
          streamId: `session/${sessionId}`,
          sessionKind: "child" as const,
          parentSessionId: root.sessionId,
          semanticState: "active" as const,
          ownerGeneration: null,
          childCapabilityGeneration: 1n,
          directAccessEnabled: true,
          rootHandleClientInstanceId: null,
          childHandleClientInstanceId: `child-${index}`,
        };
      }).reverse();
      const foldedChildren = new Set<string>();
      const repository = {
        get: (_connection: SqliteConnection, projectId: string, sessionId: string) => {
          assert.equal(projectId, PROJECT_ID);
          assert.equal(sessionId, root.sessionId);
          return root;
        },
        listDirectChildrenBounded: (
          _connection: SqliteConnection,
          projectId: string,
          rootSessionId: string,
          limit: number,
        ) => {
          assert.equal(projectId, PROJECT_ID);
          assert.equal(rootSessionId, root.sessionId);
          assert.equal(limit, 201);
          return children;
        },
        requireFoldMatch: (_connection: SqliteConnection, authority: typeof root) => {
          if (authority.sessionId === root.sessionId) return rootFold;
          foldedChildren.add(authority.sessionId);
          const ordinal = BigInt(parseInt(authority.sessionId.slice(-12), 16));
          return {
            ...rootFold,
            kind: "child" as const,
            sessionId: authority.sessionId,
            streamId: authority.streamId,
            parentSessionId: root.sessionId,
            state: "active" as const,
            ownerGeneration: null,
            childCapabilityGeneration: 1,
            streamVersion: 1n,
            eventPosition: ordinal,
          };
        },
      };
      const verifyingCapability = {
        verifyProof: (
          _material: unknown,
          target: BoundedOperationProofTargetV1,
          _proof: unknown,
        ) => {
          assert.equal(target.operationType, "read-session-tree");
          assert.equal(target.capabilityGeneration, "1");
          return { version: 1, nonce: target.proofNonce, digest: "0".repeat(64) };
        },
      };
      const query = new QueryService({
        connection: item.connection,
        authorityRepository: repository,
        capabilityService: verifyingCapability,
      });
      const result = query.read(
        primary,
        protectedReadOperation(item, primary, started, 149, "read-session-tree"),
      ) as {
        readonly children: readonly { readonly sessionId: string }[];
        readonly childrenTruncated: boolean;
      };
      assert.equal(result.children.length, 200);
      assert.equal(result.childrenTruncated, true);
      assert.equal(foldedChildren.size, 200);
      const emittedIds = result.children.map((child) => child.sessionId);
      assert.deepEqual(emittedIds, [...emittedIds].sort((left, right) => left.localeCompare(right)));
      assert.equal(emittedIds[0], lifecycleUuid(60_000));
      assert.equal(emittedIds.at(-1), lifecycleUuid(60_199));
      assert.equal(foldedChildren.has(lifecycleUuid(60_200)), false);
    } finally {
      item.connection.close();
    }
  });
});

describe("LifecycleCommandProcessor root suspension", () => {
  it("checkpoints before suspension, renews the lease, and resumes suspended state exactly once", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const item = fixture(Processor);
    try {
      const firstContext = context("primary-1");
      const started = success(item.processor.startRoot(
        firstContext,
        preparedStart(firstContext, startCommand(130)),
      ));
      item.clock.now += 40_000n;
      const suspended = success(item.processor.suspendRoot(
        firstContext,
        preparedSuspend(
          item,
          firstContext,
          started,
          suspendCommand(131, started.publicResult.sessionId, "1"),
        ),
      ));
      assert.equal(suspended.publicResult.state, "suspended");
      assert.equal(suspended.publicResult.ownerGeneration, "1");
      const rows = item.connection.prepare(`
        SELECT event_type, global_position, payload_json FROM events ORDER BY global_position
      `).all();
      assert.deepEqual(rows.map((row) => row.event_type), [
        "SessionStarted",
        "SessionCheckpointRecorded",
        "SessionSuspendRequested",
        "SessionSuspended",
      ]);
      const checkpoint = JSON.parse(String(rows[1]?.payload_json)) as {
        checkpoint: { checkpointId: string; baseEventPosition: string; checkpointEventPosition: string };
      };
      assert.equal(checkpoint.checkpoint.baseEventPosition, "1");
      assert.equal(checkpoint.checkpoint.checkpointEventPosition, "2");
      const authority = item.authority.get(item.connection, PROJECT_ID, started.publicResult.sessionId);
      assert.ok(authority !== null);
      assert.equal(authority.semanticState, "suspended");
      assert.equal(authority.latestCheckpointId, checkpoint.checkpoint.checkpointId);
      assert.equal(authority.checkpointRequiredReason, "suspension");
      assert.equal(authority.checkpointRequiredEventPosition, 4n);
      item.authority.requireFoldMatch(item.connection, authority);
      const renewed = item.leases.current(item.connection, PROJECT_ID, authority.sessionId);
      assert.ok(renewed !== null);
      assert.equal(renewed.renewedAtMs, item.clock.now);
      assert.equal(renewed.expiresAtMs, item.clock.now + OWNER_LEASE_MS);
      seedRootCheckpoint(item, authority.sessionId, 20_064);

      const secondContext = context("primary-2");
      const resumeInput = preparedResume(
        item,
        secondContext,
        suspended,
        resumeCommand(132, authority.sessionId, "1"),
      );
      item.clock.now = renewed.expiresAtMs;
      const resumed = success(item.processor.resumeRoot(secondContext, resumeInput));
      assert.equal(resumed.publicResult.state, "active");
      assert.equal(resumed.publicResult.ownerGeneration, "2");
      const finalTypes = item.connection.prepare(`
        SELECT event_type FROM events ORDER BY global_position
      `).all().map((row) => row.event_type);
      assert.deepEqual(finalTypes.slice(-2), ["SessionOwnerTransferred", "SessionResumed"]);
      const finalAuthority = item.authority.get(item.connection, PROJECT_ID, authority.sessionId);
      assert.ok(finalAuthority !== null);
      assert.equal(finalAuthority.semanticState, "active");
      assert.equal(finalAuthority.ownerGeneration, 2n);
      item.authority.requireFoldMatch(item.connection, finalAuthority);
    } finally {
      item.connection.close();
    }
  });

  it("rejects stale owner, stream, and proof tuples and rolls checkpoint/CAS/renewal back on append failure", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    let failAppend = false;
    let observedSessionId: string | undefined;
    let authorityDuringFirstInsert: SessionAuthorityRecord | null | undefined;
    let item: Fixture;
    item = fixture(Processor, {
      eventFault: (boundary) => {
        if (failAppend && boundary === "after-first-insert-before-commit") {
          authorityDuringFirstInsert = item.authority.get(
            item.connection,
            PROJECT_ID,
            observedSessionId!,
          );
          throw new Error("injected-suspend-append-failure");
        }
      },
    });
    try {
      const primary = context("primary-suspend-negative");
      const started = success(item.processor.startRoot(
        primary,
        preparedStart(primary, startCommand(700, "suspend-negative")),
      ));
      observedSessionId = started.publicResult.sessionId;
      const effectsBefore = () => [
        item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
      ];
      const originalEffects = effectsBefore();

      const wrongStreamCommand = suspendCommand(701, started.publicResult.sessionId, "2");
      assert.throws(
        () => item.processor.suspendRoot(
          primary,
          preparedSuspend(item, primary, started, wrongStreamCommand),
        ),
        (error: unknown) => (error as { code?: string }).code === "EVENT_CONFLICT",
      );

      const validCommand = suspendCommand(702, started.publicResult.sessionId, "1");
      const validPrepared = preparedSuspend(item, primary, started, validCommand);
      assert.equal(validPrepared.authorization.kind, "protected");
      assert.ok(validPrepared.authorization.proof !== null);
      const badProof: PreparedLifecycleWorkerCommand<RootSuspendCommandV2> = {
        ...validPrepared,
        authorization: {
          ...validPrepared.authorization,
          proof: {
            ...validPrepared.authorization.proof,
            proofFingerprint: "8".repeat(64),
          },
        },
      };
      assert.throws(
        () => item.processor.suspendRoot(primary, badProof),
        (error: unknown) => (error as { code?: string }).code === "SESSION_CAPABILITY_INVALID",
      );

      const foreign = context("primary-suspend-foreign");
      const foreignCommand = suspendCommand(703, started.publicResult.sessionId, "1");
      assert.throws(
        () => item.processor.suspendRoot(
          foreign,
          preparedSuspend(item, foreign, started, foreignCommand),
        ),
        (error: unknown) => (error as { code?: string }).code === "SESSION_HANDLE_STALE",
      );
      assert.deepEqual(effectsBefore(), originalEffects);

      const authorityBefore = item.authority.get(
        item.connection,
        PROJECT_ID,
        started.publicResult.sessionId,
      );
      const leaseBefore = item.leases.current(
        item.connection,
        PROJECT_ID,
        started.publicResult.sessionId,
      );
      assert.ok(authorityBefore !== null && leaseBefore !== null);
      item.operationTrace.length = 0;
      failAppend = true;
      assert.throws(
        () => item.processor.suspendRoot(primary, validPrepared),
        /injected-suspend-append-failure/u,
      );
      assert.deepEqual(item.operationTrace, ["children-list"]);
      assert.ok(authorityDuringFirstInsert !== null && authorityDuringFirstInsert !== undefined);
      assert.equal(authorityDuringFirstInsert.semanticState, "active");
      assert.equal(authorityDuringFirstInsert.latestCheckpointId, null);
      assert.equal(authorityDuringFirstInsert.checkpointRequiredReason, null);
      assert.deepEqual(
        item.authority.get(item.connection, PROJECT_ID, started.publicResult.sessionId),
        authorityBefore,
      );
      assert.deepEqual(
        item.leases.current(item.connection, PROJECT_ID, started.publicResult.sessionId),
        leaseBefore,
      );
      assert.deepEqual(effectsBefore(), originalEffects);
      assert.deepEqual(item.connection.transactionStatements.slice(-2), [
        "BEGIN IMMEDIATE",
        "ROLLBACK",
      ]);

      failAppend = false;
      const retried = success(item.processor.suspendRoot(primary, validPrepared));
      assert.equal(retried.publicResult.state, "suspended");
      assert.equal(retried.publicResult.ownerGeneration, "1");
    } finally {
      item.connection.close();
    }
  });

  it("rejects a suspension checkpoint path whose existing junction escapes the project", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const item = fixture(Processor);
    const projectRoot = mkdtempSync(join(tmpdir(), "suspend-checkpoint-root-"));
    const outside = mkdtempSync(join(tmpdir(), "suspend-checkpoint-outside-"));
    try {
      symlinkSync(outside, join(projectRoot, "linked-outside"), "junction");
      const base = context("primary-suspend-path");
      const workspace = Object.freeze({ ...base.workspace, workspaceRoot: projectRoot });
      const primary: ProjectContext = Object.freeze({
        ...base,
        workspace,
        binding: Object.freeze({
          ...base.binding,
          projectRoot,
          workspace,
        }),
      });
      const started = success(item.processor.startRoot(
        primary,
        preparedStart(primary, startCommand(710, "suspend-path")),
      ));
      const unsafeCommand: RootSuspendCommandV2 = {
        ...suspendCommand(711, started.publicResult.sessionId, "1"),
        checkpoint: {
          ...checkpointDraft(),
          filesTouched: [{
            path: "linked-outside/secret.txt",
            action: "observed",
            contentHash: null,
            branchRef: null,
            confidence: "high",
          }],
        },
      };

      assert.throws(
        () => item.processor.suspendRoot(
          primary,
          preparedSuspend(item, primary, started, unsafeCommand),
        ),
        /LIFECYCLE_INPUT_INVALID/u,
      );
      const authority = item.authority.get(item.connection, PROJECT_ID, started.publicResult.sessionId);
      assert.ok(authority !== null);
      assert.equal(authority.semanticState, "active");
      assert.equal(authority.latestCheckpointId, null);
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 1n);
    } finally {
      item.connection.close();
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("LifecycleCommandProcessor root recovery", () => {
  it("recovers to the approved primary in one ordered transaction and replays once", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const item = fixture(Processor);
    try {
      const primary = context("primary-1");
      const started = success(item.processor.startRoot(
        primary,
        preparedStart(primary, startCommand(140, "recovery-thread")),
      ));
      const suspended = success(item.processor.suspendRoot(
        primary,
        preparedSuspend(
          item,
          primary,
          started,
          suspendCommand(141, started.publicResult.sessionId, "1"),
        ),
      ));
      seedRootCheckpoint(item, started.publicResult.sessionId, 20_100);
      const before = item.authority.get(item.connection, PROJECT_ID, started.publicResult.sessionId);
      assert.ok(before !== null && before.latestCheckpointId !== null);
      const maintenance = context("maintenance-1", "maintenance");
      const command = recoveryCommand(
        142,
        before.sessionId,
        "1",
        before.latestCheckpointId,
      );
      const prepared = preparedRecovery(item, maintenance, command, "primary-2");
      item.operationTrace.length = 0;
      item.approvalEventCounts.length = 0;

      const recovered = success(item.processor.recoverRoot(maintenance, prepared));

      assert.equal(recovered.publicResult.state, "suspended");
      assert.equal(recovered.publicResult.ownerGeneration, "2");
      assert.equal(recovered.publicResult.eventPosition, "6");
      assert.equal(recovered.authorityMaterial.status, "current");
      assert.deepEqual(recovered.authorityMaterial.target, {
        actorRole: "primary",
        clientInstanceId: "primary-2",
      });
      assert.deepEqual(item.operationTrace, [
        "children-list",
        "lease-release/1",
        "authority-cas/2",
        "lease-insert/2",
        "approval-consume",
      ]);
      assert.deepEqual(item.approvalEventCounts, [6n], "approval is consumed after the exact append");
      const eventTypes = item.connection.prepare(`
        SELECT event_type FROM events ORDER BY global_position
      `).all().map((row) => row.event_type);
      assert.deepEqual(eventTypes.slice(-1), ["SessionOwnershipRecovered"]);
      const after = item.authority.get(item.connection, PROJECT_ID, before.sessionId);
      assert.ok(after !== null);
      assert.equal(after.semanticState, "suspended");
      assert.equal(after.ownerGeneration, 2n);
      assert.equal(after.rootHandleClientInstanceId, "primary-2");
      assert.notEqual(after.authorityCommitment, before.authorityCommitment);
      assert.equal(after.checkpointRequiredReason, "ownership-recovery");
      assert.equal(after.checkpointRequiredEventPosition, BigInt(recovered.publicResult.eventPosition));
      item.authority.requireFoldMatch(item.connection, after);
      const leases = item.connection.prepare(`
        SELECT owner_generation, owner_client_instance_id, released_at
        FROM session_leases ORDER BY owner_generation
      `).all();
      assert.deepEqual(leases.map((lease) => ({
        generation: lease.owner_generation,
        owner: lease.owner_client_instance_id,
        released: lease.released_at !== null,
      })), [{
        generation: 1n,
        owner: "primary-1",
        released: true,
      }, {
        generation: 2n,
        owner: "primary-2",
        released: false,
      }]);
      assert.equal(item.connection.prepare(`
        SELECT COUNT(*) AS count FROM lifecycle_approval_consumptions
      `).get()?.count, 1n);

      item.operationTrace.length = 0;
      item.approvalEventCounts.length = 0;
      const replayed = success(item.processor.recoverRoot(maintenance, prepared));
      assert.deepEqual(replayed.publicResult, recovered.publicResult);
      assert.deepEqual(item.operationTrace, []);
      assert.deepEqual(item.approvalEventCounts, []);
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 6n);
      assert.equal(item.connection.prepare(`
        SELECT COUNT(*) AS count FROM lifecycle_approval_consumptions
      `).get()?.count, 1n);
      assert.equal(suspended.publicResult.latestCheckpointEventPosition, "2");

      const recoveryCheckpoint = seedRootCheckpoint(item, after.sessionId, 20_102);

      const reusedNonceCommand = recoveryCommand(
        143,
        after.sessionId,
        "2",
        recoveryCheckpoint.checkpointId,
      );
      const reusedNonce = preparedRecovery(
        item,
        maintenance,
        reusedNonceCommand,
        "primary-3",
      );
      item.operationTrace.length = 0;
      item.approvalEventCounts.length = 0;
      assert.throws(
        () => item.processor.recoverRoot(maintenance, reusedNonce),
        (error: unknown) => (error as { code?: string }).code === "LIFECYCLE_APPROVAL_REPLAYED",
      );
      assert.deepEqual(item.operationTrace, [
        "children-list",
        "lease-release/2",
        "authority-cas/3",
        "lease-insert/3",
        "approval-consume",
      ]);
      assert.deepEqual(item.approvalEventCounts, [8n]);
      const rolledBack = item.authority.get(item.connection, PROJECT_ID, after.sessionId);
      assert.ok(rolledBack !== null);
      assert.equal(rolledBack.ownerGeneration, 2n);
      assert.equal(rolledBack.rootHandleClientInstanceId, "primary-2");
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 7n);
      assert.equal(item.connection.prepare(`
        SELECT COUNT(*) AS count FROM lifecycle_approval_consumptions
      `).get()?.count, 1n);
      const currentLease = item.leases.current(item.connection, PROJECT_ID, after.sessionId);
      assert.ok(currentLease !== null);
      assert.equal(currentLease.ownerGeneration, 2n);
      assert.equal(currentLease.ownerClientInstanceId, "primary-2");
    } finally {
      item.connection.close();
    }
  });

  it("rejects approval action, audience, intent, generation, and expiry drift without effects", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const item = fixture(Processor);
    try {
      const primary = context("primary-1");
      const started = success(item.processor.startRoot(
        primary,
        preparedStart(primary, startCommand(150, "recovery-negative-thread")),
      ));
      success(item.processor.suspendRoot(
        primary,
        preparedSuspend(
          item,
          primary,
          started,
          suspendCommand(151, started.publicResult.sessionId, "1"),
        ),
      ));
      const current = item.authority.get(item.connection, PROJECT_ID, started.publicResult.sessionId);
      assert.ok(current !== null && current.latestCheckpointId !== null);
      const maintenance = context("maintenance-1", "maintenance");
      const command = recoveryCommand(152, current.sessionId, "1", current.latestCheckpointId);
      const prepared = preparedRecovery(item, maintenance, command, "primary-2");
      const now = new Date(Number(item.clock.now)).toISOString();
      const oneMillisecondEarlier = new Date(Number(item.clock.now - 1n)).toISOString();
      const cases: readonly [string, Partial<RedactedLifecycleApproval>, string][] = [
        ["action", { action: "abandon-root" }, "SESSION_CAPABILITY_INVALID"],
        ["executor audience", { executorClientInstanceId: "maintenance-other" }, "LIFECYCLE_APPROVAL_INVALID"],
        ["target audience", {
          targetActorRole: "maintenance" as unknown as "primary",
        }, "SESSION_CAPABILITY_INVALID"],
        ["intent", { intentHash: "c".repeat(64) }, "LIFECYCLE_APPROVAL_INVALID"],
        ["generation", { expectedOwnerGeneration: "2" }, "LIFECYCLE_APPROVAL_INVALID"],
        ["expiry", {
          issuedAt: oneMillisecondEarlier,
          expiresAt: now,
        }, "LIFECYCLE_APPROVAL_EXPIRED"],
      ];

      for (const [label, overrides, expectedCode] of cases) {
        assert.throws(
          () => item.processor.recoverRoot(
            maintenance,
            withRecoveryApproval(prepared, overrides),
          ),
          (error: unknown) => {
            assert.equal((error as { code?: string }).code, expectedCode, label);
            return true;
          },
        );
      }
      assert.equal(item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count, 4n);
      assert.equal(item.connection.prepare(`
        SELECT COUNT(*) AS count FROM lifecycle_approval_consumptions
      `).get()?.count, 0n);
      const unchanged = item.authority.get(item.connection, PROJECT_ID, current.sessionId);
      assert.ok(unchanged !== null);
      assert.equal(unchanged.ownerGeneration, 1n);
      assert.equal(unchanged.rootHandleClientInstanceId, "primary-1");
    } finally {
      item.connection.close();
    }
  });

  it("fails recovery before authority work when quick integrity is unhealthy", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const item = fixture(Processor, {
      assertQuickHealthy: () => {
        throw new LifecycleError("INTEGRITY_FAILURE");
      },
    });
    try {
      const primary = context("primary-recovery-integrity");
      const started = success(item.processor.startRoot(
        primary,
        preparedStart(primary, startCommand(720, "recovery-integrity")),
      ));
      success(item.processor.suspendRoot(
        primary,
        preparedSuspend(
          item,
          primary,
          started,
          suspendCommand(721, started.publicResult.sessionId, "1"),
        ),
      ));
      const current = item.authority.get(item.connection, PROJECT_ID, started.publicResult.sessionId);
      assert.ok(current !== null && current.latestCheckpointId !== null);
      const maintenance = context("maintenance-recovery-integrity", "maintenance");
      const command = recoveryCommand(722, current.sessionId, "1", current.latestCheckpointId);
      const prepared = preparedRecovery(item, maintenance, command, "primary-recovery-target");
      const countsBefore = [
        item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM lifecycle_approval_consumptions").get()?.count,
      ];
      item.operationTrace.length = 0;

      assert.throws(
        () => item.processor.recoverRoot(maintenance, prepared),
        (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
      );

      assert.deepEqual(item.operationTrace, []);
      assert.deepEqual([
        item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM lifecycle_approval_consumptions").get()?.count,
      ], countsBefore);
      assert.deepEqual(item.connection.transactionStatements.slice(-2), [
        "BEGIN IMMEDIATE",
        "ROLLBACK",
      ]);
    } finally {
      item.connection.close();
    }
  });

  it("rejects recovery when the current lease owner mirror disagrees with root authority", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    let corruptLease = false;
    const item = fixture(Processor, {
      currentLease: (actual) => corruptLease && actual !== null
        ? Object.freeze({ ...actual, ownerClientInstanceId: "forged-recovery-lease-owner" })
        : actual,
    });
    try {
      const primary = context("primary-recovery-lease-source");
      const started = success(item.processor.startRoot(
        primary,
        preparedStart(primary, startCommand(760, "recovery-lease-owner")),
      ));
      success(item.processor.suspendRoot(
        primary,
        preparedSuspend(
          item,
          primary,
          started,
          suspendCommand(761, started.publicResult.sessionId, "1"),
        ),
      ));
      seedRootCheckpoint(item, started.publicResult.sessionId, 20_110);
      const current = item.authority.get(item.connection, PROJECT_ID, started.publicResult.sessionId);
      assert.ok(current !== null && current.latestCheckpointId !== null);
      const maintenance = context("maintenance-recovery-lease", "maintenance");
      const prepared = preparedRecovery(
        item,
        maintenance,
        recoveryCommand(762, current.sessionId, "1", current.latestCheckpointId),
        "primary-recovery-lease-target",
      );
      corruptLease = true;
      const effectsBefore = [
        item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM lifecycle_approval_consumptions").get()?.count,
      ];
      item.selectionTrace.length = 0;
      item.operationTrace.length = 0;

      assert.throws(
        () => item.processor.recoverRoot(maintenance, prepared),
        (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
      );

      assert.deepEqual(item.operationTrace, ["children-list"]);
      assert.deepEqual([
        item.connection.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM command_dedup").get()?.count,
        item.connection.prepare("SELECT COUNT(*) AS count FROM lifecycle_approval_consumptions").get()?.count,
      ], effectsBefore);
      assert.deepEqual(item.connection.transactionStatements.slice(-2), [
        "BEGIN IMMEDIATE",
        "ROLLBACK",
      ]);
    } finally {
      item.connection.close();
    }
  });

  it("preserves active state, rotates all authority, and rejects every pre-recovery capability", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const item = fixture(Processor);
    try {
      const first = context("primary-recovery-active-1");
      const started = success(item.processor.startRoot(
        first,
        preparedStart(first, startCommand(730, "recovery-active")),
      ));
      const suspended = success(item.processor.suspendRoot(
        first,
        preparedSuspend(
          item,
          first,
          started,
          suspendCommand(731, started.publicResult.sessionId, "1"),
        ),
      ));
      const second = context("primary-recovery-active-2");
      const resumePrepared = preparedResume(
        item,
        second,
        suspended,
        resumeCommand(732, suspended.publicResult.sessionId, "1", null, "exact"),
      );
      const generationOneLease = item.leases.current(
        item.connection,
        PROJECT_ID,
        suspended.publicResult.sessionId,
      );
      assert.ok(generationOneLease !== null);
      seedRootCheckpoint(item, suspended.publicResult.sessionId, 20_120);
      item.clock.now = generationOneLease.expiresAtMs;
      const active = success(item.processor.resumeRoot(second, resumePrepared));
      seedRootCheckpoint(item, active.publicResult.sessionId, 20_122);
      const before = item.authority.get(item.connection, PROJECT_ID, active.publicResult.sessionId);
      assert.ok(before !== null && before.latestCheckpointId !== null);
      const staleTarget = context("primary-recovery-active-stale");
      const preRecoveryResume = preparedResume(
        item,
        staleTarget,
        active,
        resumeCommand(733, active.publicResult.sessionId, "2", null, "exact"),
      );
      const preRecoveryRenewal = renewalOperation(item, second, active, 734);
      const maintenance = context("maintenance-recovery-active", "maintenance");
      const recovery = preparedRecovery(
        item,
        maintenance,
        recoveryCommand(735, before.sessionId, "2", before.latestCheckpointId),
        "primary-recovery-active-3",
      );
      item.operationTrace.length = 0;

      const recovered = success(item.processor.recoverRoot(maintenance, recovery));

      assert.equal(recovered.publicResult.state, "active");
      assert.equal(recovered.publicResult.ownerGeneration, "3");
      assert.deepEqual(recovered.authorityMaterial.target, {
        actorRole: "primary",
        clientInstanceId: "primary-recovery-active-3",
      });
      assert.deepEqual(item.operationTrace, [
        "children-list",
        "lease-release/2",
        "authority-cas/3",
        "lease-insert/3",
        "approval-consume",
      ]);
      const after = item.authority.get(item.connection, PROJECT_ID, before.sessionId);
      assert.ok(after !== null);
      assert.equal(after.semanticState, "active");
      assert.notEqual(after.authorityCommitment, before.authorityCommitment);
      assert.notEqual(after.rootHandleVerifier, before.rootHandleVerifier);
      assert.notEqual(after.resumeTokenVerifier, before.resumeTokenVerifier);
      assert.equal(after.rootHandleClientInstanceId, "primary-recovery-active-3");
      item.authority.requireFoldMatch(item.connection, after);

      assert.throws(
        () => item.processor.renewRootLease(second, preRecoveryRenewal),
        (error: unknown) => (error as { code?: string }).code === "SESSION_HANDLE_STALE",
      );
      assert.throws(
        () => item.processor.resumeRoot(staleTarget, preRecoveryResume),
        (error: unknown) => (error as { code?: string }).code === "SESSION_HANDLE_STALE",
      );
      assert.equal(item.connection.prepare(`
        SELECT COUNT(*) AS count FROM events WHERE event_type = 'SessionOwnershipRecovered'
      `).get()?.count, 1n);
    } finally {
      item.connection.close();
    }
  });

  it("rejects ending recovery when a nonterminal child cannot be folded", async () => {
    const Processor = await loadProcessorConstructor();
    assert.ok(Processor !== null);
    const item = fixture(Processor);
    try {
      const primary = context("primary-recovery-ending");
      const started = success(item.processor.startRoot(
        primary,
        preparedStart(primary, startCommand(740, "recovery-ending")),
      ));
      success(item.processor.suspendRoot(
        primary,
        preparedSuspend(
          item,
          primary,
          started,
          suspendCommand(741, started.publicResult.sessionId, "1"),
        ),
      ));
      const ending = transitionRootToEnding(
        item,
        primary,
        started.publicResult.sessionId,
        742,
      );
      assert.ok(ending.latestCheckpointId !== null);
      const checkpoint = seedRootCheckpoint(item, ending.sessionId, 20_130);
      const child = seedOpaqueChildSentinel(item, ending.sessionId);
      const maintenance = context("maintenance-recovery-ending", "maintenance");
      const prepared = preparedRecovery(
        item,
        maintenance,
        recoveryCommand(744, ending.sessionId, "1", checkpoint.checkpointId),
        "primary-recovery-ending-target",
      );
      item.operationTrace.length = 0;

      assert.throws(
        () => item.processor.recoverRoot(maintenance, prepared),
        (error: unknown) => (error as { code?: string }).code === "INTEGRITY_FAILURE",
      );
      assert.deepEqual(item.operationTrace, ["children-list"]);
      const after = item.authority.get(item.connection, PROJECT_ID, ending.sessionId);
      assert.ok(after !== null);
      assert.equal(after.semanticState, "ending");
      assert.equal(after.ownerGeneration, 1n);
      item.authority.requireFoldMatch(item.connection, after);
      const childAfter = item.connection.prepare(`
        SELECT * FROM session_authority WHERE project_id = $projectId AND session_id = $sessionId
      `).get({ $projectId: PROJECT_ID, $sessionId: child.sessionId });
      assert.deepEqual(childAfter, child.row);
    } finally {
      item.connection.close();
    }
  });
});
