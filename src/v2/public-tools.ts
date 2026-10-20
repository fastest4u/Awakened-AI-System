import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "../orchestrator/contracts/event.js";
import {
  FreshStartError,
  type FreshStartIdentity,
  type FreshStartRelease,
  type FreshStartState,
} from "../orchestrator/fresh-start/contracts.js";
import { bindFreshStartAdmissionContext } from "../orchestrator/fresh-start/fresh-start-admission.js";
import type { FreshStartPaths } from "../orchestrator/fresh-start/fresh-start-paths.js";
import {
  GovernedLifecycleService,
  type GovernedLifecycleMutationReceiptV1,
  type GovernedVerificationPolicyMethodV1,
} from "../orchestrator/governance/governance.service.js";
import {
  deriveGovernedNoteBinding,
  governedNoteCreateProofTargetV2,
} from "../orchestrator/governed-notes/authority.js";
import { decodeGovernedNoteCommandV2 } from "../orchestrator/governed-notes/codec.js";
import type { GovernedNoteKind } from "../orchestrator/governed-notes/contracts.js";
import { validateGovernedNotePairAny } from "../orchestrator/governed-notes/pair-validation.js";
import { GovernedNoteRepository } from "../orchestrator/governed-notes/repository.js";
import { GovernedNoteRuntimeFactory } from "../orchestrator/governed-notes/runtime.factory.js";
import type {
  BranchScopeId,
  ProjectContext,
  ProjectDescriptorV1,
  ProjectId,
  ProjectStoreRoute,
  StoreId,
  VaultId,
  WorkspaceId,
  WorkspaceSnapshot,
} from "../orchestrator/identity/contracts.js";
import { computeProjectContextFingerprint } from "../orchestrator/identity/project-binding.service.js";
import { EventIntegrityService } from "../orchestrator/integrity/event-integrity.service.js";
import { OperationalKeyCustodyProvider } from "../orchestrator/keys/operational-key-custody.js";
import {
  issueRecoveryApproval,
  verifyRecoveryApproval,
} from "../orchestrator/lifecycle/authority/approval-codec.js";
import { createCapabilityProof } from "../orchestrator/lifecycle/authority/capability-codec.js";
import {
  CapabilityService,
  type StoredCapabilityMaterialV1,
} from "../orchestrator/lifecycle/capability.service.js";
import type { CheckpointDraftV2 } from "../orchestrator/lifecycle/contracts/checkpoint.js";
import { decodeLifecycleSemanticCommandDraft } from "../orchestrator/lifecycle/contracts/commands.js";
import type { SessionId } from "../orchestrator/lifecycle/contracts/identifiers.js";
import { connectionBoundEvidenceCoverage } from "../orchestrator/lifecycle/lifecycle-command.store.js";
import { buildLifecycleIntentWitness } from "../orchestrator/lifecycle/lifecycle-intent-witness.js";
import { decodeRetainEvidenceBatch } from "../orchestrator/privacy/evidence-contracts.js";
import type { TrustedRedactionPolicyV1 } from "../orchestrator/privacy/redaction.js";
import { retainedEvidenceProofTarget } from "../orchestrator/privacy/retained-evidence-authority.js";
import { RetainedEvidenceRuntimeFactory } from "../orchestrator/privacy/retained-evidence-runtime.factory.js";
import { ImmutableProjectionBuilder } from "../orchestrator/projections/builder.js";
import type { ProjectBinding } from "../orchestrator/projections/contracts.js";
import { V2ProjectionBuildCoordinator } from "../orchestrator/projections/coordinator.js";
import { SqliteProjectionEventReader } from "../orchestrator/projections/event-reader.js";
import { openImmutableProjectionImage } from "../orchestrator/projections/immutable-image.js";
import {
  parseRichProjectionManifest,
  type ProjectionManifestV3,
} from "../orchestrator/projections/manifest-codec.js";
import type { ProjectionDirectoryIdentity } from "../orchestrator/projections/stable-directory.js";
import { decodeLifecycleWorkerOperationWire } from "../orchestrator/runtime/lifecycle-worker-protocol.js";
import { LifecycleWorkerRuntimeFactory } from "../orchestrator/runtime/lifecycle-worker-runtime.factory.js";
import { canonicalJson } from "../orchestrator/serialization/canonical-json.js";
import { ChildTransferRepository } from "../orchestrator/storage/child-transfer.repository.js";
import { GENESIS_GLOBAL_HASH } from "../orchestrator/storage/event-chain-constants.js";
import { EvidenceCoverageRepository } from "../orchestrator/storage/evidence-coverage.repository.js";
import { LifecycleApprovalRepository } from "../orchestrator/storage/lifecycle-approval.repository.js";
import { SqliteLifecycleProjectionRepository } from "../orchestrator/storage/lifecycle-projection.repository.js";
import type { SessionAuthorityRecord } from "../orchestrator/storage/lifecycle-storage.types.js";
import { MaintenanceFence } from "../orchestrator/storage/maintenance-fence.js";
import { NodeSqliteDriver } from "../orchestrator/storage/node-sqlite-driver.js";
import { SessionAuthorityRepository } from "../orchestrator/storage/session-authority.repository.js";
import { SessionLeaseRepository } from "../orchestrator/storage/session-lease.repository.js";
import type { SqliteConnection } from "../orchestrator/storage/sqlite-driver.js";
import { queryNativeContent } from "../orchestrator/verified-read/content-query.js";
import { buildNativeContentResult } from "../orchestrator/verified-read/content-result.js";
import type { VerifiedReadBinding } from "../orchestrator/verified-read/contracts.js";
import {
  decodeFullNoteVerifiedReadReceipt,
  decodeGetFullNoteRequest,
} from "../orchestrator/verified-read/full-note-protocol.js";
import { queryNativeFullNote } from "../orchestrator/verified-read/full-note-query.js";
import { buildNativeFullNoteResult } from "../orchestrator/verified-read/full-note-result.js";
import {
  decodeVerifiedReadReceipt,
  decodeVerifiedReadRequest,
} from "../orchestrator/verified-read/protocol.js";
import { createVerifiedReadAdapter } from "../orchestrator/verified-read/supervisor.js";
import type { NativeCanonicalPageResult } from "../orchestrator/verified-read/workflow-contracts.js";
import {
  V2_NATIVE_TOOLS,
  V2_SUPERSEDED_V1_TOOLS,
  V2_SUPPORTED_V1_TOOLS,
  V2_UNAVAILABLE_V1_TOOLS,
} from "./capabilities.js";

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, unknown>>;
    readonly additionalProperties?: boolean;
  };
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly openWorldHint: boolean;
  };
}

export const STATUS_TOOL_DEFINITION: McpToolDefinition = Object.freeze({
  name: "memory_v2Status",
  description: "Redacted fresh-start V2 status and capability posture.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
  annotations: Object.freeze({
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  }),
});

const READ_ONLY_PUBLIC_TOOLS = new Set<string>([
  "memory_v2Status",
  "memory_search",
  "memory_get",
  "memory_list",
  "memory_recent",
  "memory_contextPack",
  "memory_followUpRadar",
  "memory_awaken",
  "memory_verifyVault",
  "memory_verifyNote",
  "memory_verifySourceTruth",
  "memory_findDuplicates",
  "memory_checkStaleness",
  "memory_lifecycleStatus",
  "memory_selfCheck",
]);

function buildPublicToolDefinitions(): readonly McpToolDefinition[] {
  const allPublicTools = [
    ...V2_SUPPORTED_V1_TOOLS,
    ...V2_NATIVE_TOOLS,
  ];
  return Object.freeze(
    allPublicTools.map((name) => {
      if (name === "memory_v2Status") return STATUS_TOOL_DEFINITION;
      const readOnly = READ_ONLY_PUBLIC_TOOLS.has(name);
      return Object.freeze({
        name,
        description: `Project Memory V2 governed tool: ${name}`,
        inputSchema: Object.freeze({
          type: "object",
          properties: Object.freeze({}),
          additionalProperties: true,
        }),
        annotations: Object.freeze({
          readOnlyHint: readOnly,
          destructiveHint: name === "memory_forgetEvidence",
          openWorldHint: false,
        }),
      });
    }),
  );
}

export const V2_PUBLIC_TOOL_DEFINITIONS: readonly McpToolDefinition[] = buildPublicToolDefinitions();

const DEFAULT_REDACTION_POLICY: TrustedRedactionPolicyV1 = Object.freeze({
  policyId: "v2-public-default-redaction",
  policyVersion: "1",
  rules: Object.freeze([
    Object.freeze({
      kind: "token" as const,
      ruleId: "rule-fixture-secret",
      prefix: "fixture_secret",
    }),
  ]),
});

const READ_SOURCE_STATE_HASH = "a".repeat(64);

function normalizeArgs(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FreshStartError("FRESH_START_INPUT_INVALID");
  }
  return value as Record<string, unknown>;
}

function serializeMutationReceipt(
  receipt: GovernedLifecycleMutationReceiptV1,
): Record<string, unknown> {
  return {
    commandId: receipt.commandId,
    idempotencyKey: receipt.idempotencyKey,
    eventId: receipt.eventId,
    globalPosition: receipt.globalPosition.toString(),
    streamVersion: receipt.streamVersion.toString(),
    recordId: receipt.recordId,
    targetStatus: receipt.targetStatus,
    verificationMethod: receipt.verificationMethod,
    verificationAnchor: receipt.verificationAnchor,
    validTo: receipt.validTo,
    conflictKey: receipt.conflictKey,
    conflictGroupId: receipt.conflictGroupId,
    resolutionState: receipt.resolutionState,
    resolutionEventId: receipt.resolutionEventId,
    supersededByEventId: receipt.supersededByEventId,
    supersedingRecordId: receipt.supersedingRecordId,
    retractedByEventId: receipt.retractedByEventId,
    replayed: receipt.replayed,
  };
}

function resolveInternalDeploymentDirectory(): ProjectionDirectoryIdentity {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "internal"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "internal"),
    join(process.cwd(), "dist", "internal"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const canonicalPath = realpathSync.native(candidate);
      const stat = lstatSync(canonicalPath, { bigint: true });
      return Object.freeze({
        canonicalPath,
        device: String(stat.dev),
        inode: String(stat.ino),
      });
    }
  }
  throw new FreshStartError("FRESH_START_STORAGE_FAILURE");
}

function resolveDirectoryIdentity(dirPath: string): ProjectionDirectoryIdentity {
  mkdirSync(dirPath, { recursive: true });
  const canonicalPath = realpathSync.native(dirPath);
  const stat = lstatSync(canonicalPath, { bigint: true });
  return Object.freeze({
    canonicalPath,
    device: String(stat.dev),
    inode: String(stat.ino),
  });
}

function emptyCheckpointDraftV2(taskSummary: string): CheckpointDraftV2 {
  return Object.freeze({
    checkpointVersion: 2 as const,
    taskSummary,
    completedItems: Object.freeze([]),
    inProgressItems: Object.freeze([]),
    blockers: Object.freeze([]),
    nextActions: Object.freeze([]),
    decisions: Object.freeze([]),
    assumptions: Object.freeze([]),
    unresolvedConflicts: Object.freeze([]),
    filesTouched: Object.freeze([]),
    artifactReferences: Object.freeze([]),
    sourceReferences: Object.freeze([]),
    commandResults: Object.freeze([]),
    testResults: Object.freeze([]),
    materialClaims: Object.freeze([]),
  });
}

export interface V2PublicToolRouterOptions {
  readonly connection: SqliteConnection;
  readonly identity: FreshStartIdentity;
  readonly paths: FreshStartPaths;
  readonly descriptor: ProjectDescriptorV1;
  readonly workspace: WorkspaceSnapshot;
  readonly route: ProjectStoreRoute;
}

export class V2PublicToolRouter {
  readonly #connection: SqliteConnection;
  readonly #identity: FreshStartIdentity;
  readonly #paths: FreshStartPaths;
  readonly #descriptor: ProjectDescriptorV1;
  readonly #workspace: WorkspaceSnapshot;
  readonly #route: ProjectStoreRoute;
  readonly #custody: OperationalKeyCustodyProvider;
  readonly #rootContext: ProjectContext;
  readonly #childContext: ProjectContext;
  readonly #projectionBinding: ProjectBinding;
  readonly #authorityRepo: SessionAuthorityRepository;
  readonly #capabilities: CapabilityService;
  readonly #lifecycleRuntime: ReturnType<LifecycleWorkerRuntimeFactory["create"]>;
  readonly #retainedEvidenceRuntime: ReturnType<RetainedEvidenceRuntimeFactory["create"]>;
  readonly #governedNoteRuntime: ReturnType<GovernedNoteRuntimeFactory["create"]>;
  readonly #governanceService: GovernedLifecycleService;
  #nextUuid: string | undefined;
  #admissionContextBound = false;

  constructor(options: V2PublicToolRouterOptions) {
    this.#connection = options.connection;
    this.#identity = options.identity;
    this.#paths = options.paths;
    this.#descriptor = options.descriptor;
    this.#workspace = options.workspace;
    this.#route = options.route;

    this.#custody = new OperationalKeyCustodyProvider({
      storeRoot: options.route.storeRoot,
      projectId: options.identity.projectId,
      storeId: options.identity.storeId,
      paths: options.paths,
    });

    const descriptorPath = join(options.paths.v2VaultRoot, ".memory-mcp", "project-identity.json");
    const nowIso = new Date().toISOString();
    const baseBinding = {
      projectBindingId: randomUUID(),
      generation: 1,
      source: "stdio-explicit-root" as const,
      projectId: options.identity.projectId as ProjectId,
      vaultId: options.identity.vaultId as VaultId,
      storeId: options.identity.storeId as StoreId,
      workspaceId: options.workspace.workspaceId,
      projectRoot: options.paths.projectRoot,
      vaultRoot: options.paths.v2VaultRoot,
      descriptorPath,
      storeRoute: options.route,
      workspace: options.workspace,
      clientNamespace: "mcp-v2",
      clientInstanceId: "v2-mcp-primary",
      actorRole: "primary" as const,
      establishedAt: nowIso,
      contextFingerprint: "",
    };
    this.#rootContext = Object.freeze({
      workspace: options.workspace,
      checkedAt: nowIso,
      binding: Object.freeze({
        ...baseBinding,
        contextFingerprint: computeProjectContextFingerprint(baseBinding),
      }),
    });

    const childBindingBase = {
      ...baseBinding,
      projectBindingId: randomUUID(),
      actorRole: "untrusted" as const,
      clientInstanceId: "v2-mcp-child",
    };
    this.#childContext = Object.freeze({
      workspace: options.workspace,
      checkedAt: nowIso,
      binding: Object.freeze({
        ...childBindingBase,
        contextFingerprint: computeProjectContextFingerprint(childBindingBase),
      }),
    });

    const branchRef = options.workspace.kind === "git" ? options.workspace.branchRef : null;
    const branchScopeRow = options.connection
      .prepare(
        `SELECT branch_scope_id FROM branch_scopes
         WHERE project_id = $projectId AND retired_at IS NULL
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get({
        $projectId: options.identity.projectId,
      }) as { branch_scope_id?: string } | undefined;

    const branchScopeId = (branchScopeRow?.branch_scope_id ?? null) as BranchScopeId | null;

    this.#projectionBinding = Object.freeze({
      projectId: options.identity.projectId as ProjectId,
      vaultId: options.identity.vaultId as VaultId,
      storeId: options.identity.storeId as StoreId,
      workspaceId: options.workspace.workspaceId,
      branchScopeId,
      branchRef,
      sessionId: null,
    });

    const clock = {
      now: () => new Date().toISOString(),
      nowMs: () => BigInt(Date.now()),
    };
    const ids = {
      uuid: () => {
        const override = this.#nextUuid;
        this.#nextUuid = undefined;
        return override ?? randomUUID();
      },
      bytes: (length: number) => randomBytes(length),
    };
    const sourceState = () => ({
      sourceStateScopeVersion: 1 as const,
      workspaceId: options.workspace.workspaceId,
      branchRef,
      headCommit: options.workspace.kind === "git" ? options.workspace.headCommit : null,
      dirtyWorktreeFingerprint: READ_SOURCE_STATE_HASH,
    });

    const maintenanceFence = new MaintenanceFence();
    this.#authorityRepo = new SessionAuthorityRepository();
    this.#capabilities = new CapabilityService({
      keyProvider: this.#custody.capability,
      clock,
      nonceSource: ids,
    });

    const lifecycleFactory = new LifecycleWorkerRuntimeFactory({
      clock,
      identitySource: ids,
      integrity: { assertQuickHealthy: () => undefined },
      resumeSourceState: { captureCurrent: sourceState },
      checkpointSourceStateProvider: {
        capture: async () => sourceState(),
        captureForCheckpoint: sourceState,
        captureForFinalization: sourceState,
      },
      checkpointSourceStateScopeResolver: {
        resolve: () => ({
          scopeVersion: 1,
          descriptorPath,
          storeRoot: options.route.storeRoot,
          privateStateRoot: options.route.storeRoot,
          exactMaterializationTargets: [],
          exactCommittedTempPaths: [],
        }),
      },
      childBindingFingerprint: (target) =>
        target.actorRole === "untrusted"
        && target.clientInstanceId === this.#childContext.binding.clientInstanceId
          ? this.#childContext.binding.contextFingerprint
          : null,
      repositories: {
        authority: () => new SessionAuthorityRepository(),
        leases: () => new SessionLeaseRepository(),
        approvals: () => new LifecycleApprovalRepository(),
        transfers: () => new ChildTransferRepository(),
        coverage: (provider) => new EvidenceCoverageRepository(provider),
        projection: (conn) => new SqliteLifecycleProjectionRepository(conn),
      },
      transactionFacades: {
        command: ({ connection, authority, leases, approvals, transfers, coverage }) => ({
          authority: {
            get: (projectId: string, sessionId: string) =>
              authority.get(connection, projectId, sessionId),
            insertRoot: (input: unknown) => authority.insertRoot(connection, input as never),
            insertChild: (input: unknown) => authority.insertChild(connection, input as never),
            compareAndSwap: (input: unknown) =>
              authority.compareAndSwap(connection, input as never),
            listSafeResumeCandidates: (input: unknown) =>
              authority.listSafeResumeCandidates(connection, input as never),
            listNonterminalRootContinuityOwners: (input: unknown) =>
              authority.listNonterminalRootContinuityOwners(connection, input as never),
            listNonterminalChildren: (projectId: string, rootSessionId: string) =>
              authority.listNonterminalChildren(connection, projectId, rootSessionId),
            listNonterminalChildEndingScopeProjectionsBounded: (
              projectId: string,
              rootSessionId: string,
              limit: number,
            ) =>
              authority.listNonterminalChildEndingScopeProjectionsBounded(
                connection,
                projectId,
                rootSessionId,
                limit,
              ),
            rootContinuityKey: (value: unknown) =>
              authority.rootContinuityKey(connection, value as never),
            latestCheckpoint: (value: unknown) =>
              authority.latestCheckpoint(connection, value as never),
            nextGlobalPosition: () => authority.nextGlobalPosition(connection),
            loadEvents: (value: unknown) => authority.loadEvents(connection, value as never),
            requireFoldMatch: (value: unknown) =>
              authority.requireFoldMatch(connection, value as never),
            markCheckpointRequired: (input: unknown) =>
              authority.markCheckpointRequired(connection, input as never),
            updateCheckpointIndex: (input: unknown) =>
              authority.updateCheckpointIndex(connection, input as never),
            clearCheckpointRequired: (input: unknown) =>
              authority.clearCheckpointRequired(connection, input as never),
          },
          leases: {
            current: (projectId: string, sessionId: string) =>
              leases.current(connection, projectId, sessionId),
            isExpired: (value: unknown, now: bigint) => leases.isExpired(value as never, now),
            insertGeneration: (input: unknown) =>
              leases.insertGeneration(connection, input as never),
            renewCurrent: (input: unknown) => leases.renewCurrent(connection, input as never),
            releaseCurrent: (input: unknown) => leases.releaseCurrent(connection, input as never),
          },
          approvals: {
            consume: (input: unknown) => approvals.consume(connection, input as never),
          },
          transfers: {
            get: (projectId: string, ticketId: string) =>
              transfers.get(connection, projectId, ticketId),
            findCreatedEventPosition: (projectId: string, ticketId: string) =>
              transfers.findCreatedEventPosition(connection, projectId, ticketId),
            listUnclaimedEndingScopeProjectionsBySourceRoot: (
              projectId: string,
              rootSessionId: string,
              limit: number,
            ) =>
              transfers.listUnclaimedEndingScopeProjectionsBySourceRoot(
                connection,
                projectId,
                rootSessionId,
                limit,
              ),
            insert: (input: unknown) => transfers.insert(connection, input as never),
            claim: (input: unknown) => transfers.claim(connection, input as never),
          },
          coverage: connectionBoundEvidenceCoverage(connection, coverage),
          workflows: {} as never,
          validation: {} as never,
          outbox: {} as never,
        }),
        operational: () => ({ workflows: {}, outbox: {} } as never),
      },
    });

    this.#lifecycleRuntime = lifecycleFactory.create({
      connection: options.connection,
      maintenanceFence,
      keyProvider: this.#custody.capability,
    });

    this.#retainedEvidenceRuntime = new RetainedEvidenceRuntimeFactory({
      provider: this.#custody.evidence,
      policy: () => DEFAULT_REDACTION_POLICY,
      clock,
      nonceSource: ids,
    }).create({
      connection: options.connection,
      maintenanceFence,
      keyProvider: this.#custody.capability,
    });

    this.#governedNoteRuntime = new GovernedNoteRuntimeFactory({
      provider: this.#custody.evidence,
      policy: () => DEFAULT_REDACTION_POLICY,
      clock,
      nonceSource: ids,
    }).create({
      connection: options.connection,
      maintenanceFence,
      keyProvider: this.#custody.capability,
    });

    this.#governanceService = new GovernedLifecycleService({
      connection: options.connection,
      context: this.#rootContext,
      custody: this.#custody,
      now: () => clock.now(),
    });
  }

  close(): void {
    try {
      this.#lifecycleRuntime.dispose();
    } finally {
      this.#custody.close();
    }
  }

  async invoke(
    name: string,
    argumentsValue: unknown,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<unknown> {
    if (Object.prototype.hasOwnProperty.call(V2_SUPERSEDED_V1_TOOLS, name)) {
      const meta = V2_SUPERSEDED_V1_TOOLS[name as keyof typeof V2_SUPERSEDED_V1_TOOLS];
      throw Object.assign(new FreshStartError("FRESH_START_OPERATOR_ONLY_TOOL"), {
        toolName: name,
        supersededBy: meta.supersededBy,
      });
    }
    if ((V2_UNAVAILABLE_V1_TOOLS as readonly string[]).includes(name)) {
      throw new FreshStartError("FRESH_START_CAPABILITY_UNAVAILABLE");
    }
    if (
      !(V2_SUPPORTED_V1_TOOLS as readonly string[]).includes(name)
      && !(V2_NATIVE_TOOLS as readonly string[]).includes(name)
    ) {
      throw new FreshStartError("FRESH_START_CAPABILITY_UNAVAILABLE");
    }
    if (state.mode === "read-only-recovery" && !READ_ONLY_PUBLIC_TOOLS.has(name)) {
      throw new FreshStartError("FRESH_START_ADMISSION_DENIED");
    }

    if (state.mode === "active" && !this.#admissionContextBound) {
      bindFreshStartAdmissionContext(this.#connection, {
        identity: this.#identity,
        releaseId: release.releaseId,
        measuredBuildHash: release.buildIdentityHash,
        generation: state.generation,
      });
      this.#admissionContextBound = true;
    }

    const args = normalizeArgs(argumentsValue);

    switch (name) {
      case "memory_sessionStart":
        return this.#handleSessionStart(args, state);
      case "memory_lifecycleStatus":
        return this.#handleLifecycleStatus(args, state);
      case "memory_selfCheck":
        return this.#handleSelfCheck(args, state);
      case "memory_writeInsight":
        return this.#handleWriteGovernedNote("insight", args);
      case "memory_writeMistake":
        return this.#handleWriteGovernedNote("mistake", args);
      case "memory_writeADR":
        return this.#handleWriteGovernedNote("adr", args);
      case "memory_writeSessionLog":
        return this.#handleWriteGovernedNote("session-log", args);
      case "memory_get":
        return this.#handleGetFullNote(args, state, release);
      case "memory_search":
        return this.#handleSearch(args, state, release);
      case "memory_list":
        return this.#handleList(args, state, release);
      case "memory_recent":
        return this.#handleRecent(args, state, release);
      case "memory_contextPack":
        return this.#handleContextPack(args, state, release);
      case "memory_followUpRadar":
        return this.#handleFollowUpRadar(args, state, release);
      case "memory_awaken":
        return this.#handleAwaken(args, state, release);
      case "memory_verifyVault":
        return this.#handleVerifyVault(release);
      case "memory_verifyNote":
        return this.#handleVerifyNote(args, state, release);
      case "memory_verifySourceTruth":
        return this.#handleVerifySourceTruth(release);
      case "memory_findDuplicates":
        return this.#handleFindDuplicates();
      case "memory_checkStaleness":
        return this.#handleCheckStaleness();
      case "memory_promote":
        return this.#handlePromote(args);
      case "memory_supersede":
        return this.#handleSupersede(args);
      case "memory_retract":
        return this.#handleRetract(args);
      case "memory_expire":
        return this.#handleExpire(args);
      case "memory_recordEvidenceBatch":
        return this.#handleRecordEvidenceBatch(args);
      case "memory_forgetEvidence":
        return this.#handleForgetEvidence(args);
      case "memory_checkpoint":
        return this.#handleCheckpoint(args);
      case "memory_sessionFork":
        return this.#handleSessionFork(args);
      case "memory_recordChildResult":
        return this.#handleRecordChildResult(args);
      case "memory_completeChildSession":
        return this.#handleCompleteChildSession(args);
      case "memory_recoverSession":
        return this.#handleRecoverSession(args);
      case "memory_sessionEnd":
        return this.#handleSessionEnd(args);
      case "memory_amendSessionEnd":
        return this.#handleAmendSessionEnd(args);
      case "memory_cancelSessionEnd":
        return this.#handleCancelSessionEnd(args);
      default:
        throw new FreshStartError("FRESH_START_CAPABILITY_UNAVAILABLE");
    }
  }

  #storedHandle(row: SessionAuthorityRecord): StoredCapabilityMaterialV1 {
    const root = row.sessionKind === "root";
    const generation = root ? row.ownerGeneration : row.childCapabilityGeneration;
    const prefix = root ? "rootHandle" : "childHandle";
    const field = (suffix: string) =>
      (row as unknown as Record<string, unknown>)[`${prefix}${suffix}`];
    if (!generation) {
      throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
    }
    return Object.freeze({
      claims: Object.freeze({
        capabilityVersion: 1,
        keyId: String(field("KeyId")),
        projectId: row.projectId,
        vaultId: this.#rootContext.binding.vaultId,
        storeId: this.#rootContext.binding.storeId,
        workspaceId: row.workspaceId,
        clientNamespace: row.clientNamespace,
        sessionId: row.sessionId,
        kind: root ? ("root-session-handle" as const) : ("child-session-handle" as const),
        capabilityGeneration: generation.toString(),
        issuedAt: String(field("IssuedAt")),
        policyCode: String(field("PolicyCode")),
        expiryKind: String(field("ExpiryKind")),
        expiresAt: field("ExpiresAt") as string | null,
        issueNonce: String(field("IssueNonce")),
        actorRole: field("ActorRole") as "primary" | "untrusted",
        clientInstanceId: String(field("ClientInstanceId")),
      }),
      verifier: String(field("Verifier")),
    }) as StoredCapabilityMaterialV1;
  }

  #mintProof(
    sessionId: string,
    context: ProjectContext,
    buildTarget: (scope: {
      projectId: ProjectContext["binding"]["projectId"];
      vaultId: ProjectContext["binding"]["vaultId"];
      storeId: ProjectContext["binding"]["storeId"];
      workspaceId: ProjectContext["binding"]["workspaceId"];
      clientNamespace: string;
      authoritySessionId: SessionId;
      targetSessionId: SessionId;
      presentingActorRole: "primary" | "untrusted";
      targetActorRole: "primary" | "untrusted",
      presentingClientInstanceId: string;
      targetClientInstanceId: string;
      capabilityKind: "root-session-handle" | "child-session-handle";
      capabilityGeneration: string;
    }) => Parameters<typeof createCapabilityProof>[1],
  ) {
    const row = this.#authorityRepo.get(
      this.#connection,
      context.binding.projectId,
      sessionId,
    );
    if (!row) {
      throw new FreshStartError("FRESH_START_INPUT_INVALID");
    }
    const stored = this.#storedHandle(row);
    const generation = stored.claims.capabilityGeneration;
    const audience = {
      actorRole: context.binding.actorRole as "primary" | "untrusted",
      clientInstanceId: context.binding.clientInstanceId,
    };
    const resolution = this.#capabilities.authorityMaterial({
      authorityCommitment: row.authorityCommitment,
      expectedCapabilityGeneration: generation,
      currentCapabilityGeneration: generation,
      target: audience,
      materials: [stored],
    });
    if (!resolution.descriptor) {
      throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
    }
    const reconstructed = this.#capabilities.reconstructForTarget(
      resolution.descriptor,
      audience,
    );
    try {
      const b = context.binding;
      const scope = {
        projectId: b.projectId,
        vaultId: b.vaultId,
        storeId: b.storeId,
        workspaceId: b.workspaceId,
        clientNamespace: b.clientNamespace,
        authoritySessionId: sessionId as SessionId,
        targetSessionId: sessionId as SessionId,
        presentingActorRole: b.actorRole as "primary" | "untrusted",
        targetActorRole: b.actorRole as "primary" | "untrusted",
        presentingClientInstanceId: b.clientInstanceId,
        targetClientInstanceId: b.clientInstanceId,
        capabilityKind:
          b.actorRole === "primary"
            ? ("root-session-handle" as const)
            : ("child-session-handle" as const),
        capabilityGeneration: generation,
      };
      return createCapabilityProof(reconstructed.handle, buildTarget(scope));
    } finally {
      reconstructed.handle.destroy();
      if (reconstructed.kind === "root") {
        reconstructed.resumeToken?.destroy();
      }
    }
  }

  #resolveActiveRootSessionId(explicitSessionId?: unknown): string | null {
    if (typeof explicitSessionId === "string" && explicitSessionId.trim().length > 0) {
      return explicitSessionId.trim();
    }
    const row = this.#connection
      .prepare(
        `SELECT session_id FROM session_authority
         WHERE project_id = $projectId AND session_kind = 'root' AND terminal_at IS NULL
         ORDER BY authority_event_position DESC LIMIT 1`,
      )
      .get({ $projectId: this.#identity.projectId }) as { session_id?: string } | undefined;
    return row?.session_id ?? null;
  }

  async #ensureActiveRootSession(explicitSessionId?: unknown): Promise<string> {
    const existing = this.#resolveActiveRootSessionId(explicitSessionId);
    if (existing !== null) return existing;
    const started = await this.#startNewRootSession("mcp-auto-session");
    return started.sessionId;
  }

  async #startNewRootSession(continuityPrefix = "mcp-root"): Promise<{
    readonly sessionId: string;
    readonly conversationId: string;
    readonly evidenceIds: readonly string[];
    readonly eventIds: readonly string[];
  }> {
    const b = this.#rootContext.binding;
    const branchRef = this.#projectionBinding.branchRef;
    const sessionId = randomUUID();
    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "root-start",
      commandId: sessionId,
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: branchRef,
      continuityKey: `${continuityPrefix}/${sessionId}`,
      resumePolicy: "new",
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "initial-authority",
      authorizationSessionId: null,
      targetSessionId: command.commandId,
      capabilityKind: null,
      capabilityGeneration: null,
    });
    this.#nextUuid = sessionId;
    try {
      await this.#lifecycleRuntime.execute(
        decodeLifecycleWorkerOperationWire({
          kind: "semantic",
          operation: "root-start",
          prepared: {
            command,
            candidateIntentHash: witness.intentHash,
            authorization: {
              kind: "initial-authority",
              authoritySessionId: null,
              targetSessionId: null,
              proof: null,
              approval: null,
              childBindingGrant: null,
            },
          },
        }),
        this.#rootContext,
      );
    } finally {
      this.#nextUuid = undefined;
    }

    const retained = this.#retainEvidenceForSession(
      sessionId,
      "Session started on V2 governed MCP surface",
    );
    return {
      sessionId,
      conversationId: retained.conversationId,
      evidenceIds: retained.evidenceIds,
      eventIds: retained.eventIds,
    };
  }

  #retainEvidenceForSession(
    sessionId: string,
    content: string,
    conversationId: string = randomUUID(),
  ): {
    readonly conversationId: string;
    readonly evidenceIds: readonly string[];
    readonly eventIds: readonly string[];
  } {
    const decoded = decodeRetainEvidenceBatch({
      version: 1,
      commandType: "retain-evidence-batch",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      targetSessionId: sessionId,
      conversationId,
      frames: [
        {
          frameId: randomUUID(),
          ordinal: "0",
          role: "user",
          category: "user-message",
          occurredAt: new Date().toISOString(),
          mediaType: "text/plain; charset=utf-8",
          content,
          previousFrameId: null,
          toolCorrelationId: null,
          artifactHashes: [],
        },
      ],
    });
    try {
      const proof = this.#mintProof(sessionId, this.#rootContext, (scope) =>
        retainedEvidenceProofTarget(decoded, scope, randomUUID()),
      );
      const result = this.#retainedEvidenceRuntime.execute(
        {
          command: decoded.command,
          authorization: {
            kind: "protected",
            authoritySessionId: sessionId as SessionId,
            targetSessionId: sessionId as SessionId,
            proof,
            approval: null,
            childBindingGrant: null,
          },
        },
        this.#rootContext,
      );
      return {
        conversationId,
        evidenceIds: result.response.evidenceIds,
        eventIds: result.eventIds,
      };
    } finally {
      decoded.canonicalOriginalBytes.fill(0);
    }
  }

  async #publishProjectionV3(force = false): Promise<ProjectionManifestV3> {
    const projectionDir = join(this.#route.storeRoot, "projections");
    mkdirSync(projectionDir, { recursive: true });
    const manifestPath = join(projectionDir, "projection-manifest.json");
    let activeProjectionBinding: ProjectBinding = this.#projectionBinding;
    if (existsSync(manifestPath)) {
      try {
        const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          projectId?: string;
          vaultId?: string;
          storeId?: string;
          workspaceId?: string;
          branchScopeId?: string | null;
          branchRef?: string | null;
        };
        if (rawManifest.projectId === this.#projectionBinding.projectId) {
          activeProjectionBinding = Object.freeze({
            ...this.#projectionBinding,
            branchScopeId:
              (rawManifest.branchScopeId ?? this.#projectionBinding.branchScopeId) as BranchScopeId | null,
            branchRef:
              rawManifest.branchRef !== undefined
                ? rawManifest.branchRef
                : this.#projectionBinding.branchRef,
          });
        }
        const prior = parseRichProjectionManifest(rawManifest, activeProjectionBinding);
        if (
          !force
          && prior.schemaVersion === 3
          && prior.terminalEventPosition.toString() === this.#currentGlobalPosition()
        ) {
          return prior;
        }
      } catch {
        // Proceed to coordinator-governed build/reconciliation.
      }
    }

    const branchScopeRow = this.#connection
      .prepare(
        `SELECT branch_scope_id FROM branch_scopes
         WHERE project_id = $projectId AND retired_at IS NULL
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get({
        $projectId: this.#identity.projectId,
      }) as { branch_scope_id?: string } | undefined;
    if (
      branchScopeRow?.branch_scope_id
      && branchScopeRow.branch_scope_id !== activeProjectionBinding.branchScopeId
    ) {
      activeProjectionBinding = Object.freeze({
        ...activeProjectionBinding,
        branchScopeId: branchScopeRow.branch_scope_id as BranchScopeId,
      });
    }

    const driver = new NodeSqliteDriver({ DatabaseSync });
    const eventReader = new SqliteProjectionEventReader({
      driver,
      eventStorePath: this.#route.eventsPath,
      busyTimeoutMs: 5000,
    });
    const builder = new ImmutableProjectionBuilder({
      driver,
      projectionDirectory: projectionDir,
      now: () => new Date().toISOString(),
    });
    const coordinator = new V2ProjectionBuildCoordinator({
      eventReader,
      builder,
      projectionDirectory: projectionDir,
      schema3: {
        eventReader,
        builder,
      },
    });
    const published = await coordinator.ensurePublishedV3(
      activeProjectionBinding,
      BigInt(this.#currentGlobalPosition()),
      30_000,
    );
    return published.manifest;
  }

  async #withVerifiedReadAdapter<T>(
    state: FreshStartState,
    release: FreshStartRelease,
    sessionId: string | null,
    fn: (
      adapter: Pick<ReturnType<typeof createVerifiedReadAdapter>, "query" | "queryFullNote">,
    ) => Promise<T>,
  ): Promise<T> {
    const manifest = await this.#publishProjectionV3(false);
    const projectionDirectory = resolveDirectoryIdentity(
      join(this.#route.storeRoot, "projections"),
    );
    const executorStateDirectory = resolveDirectoryIdentity(
      join(this.#route.storeRoot, "verified-read-executor"),
    );
    const deploymentDirectory = resolveInternalDeploymentDirectory();
    const eventsPath = realpathSync.native(this.#route.eventsPath);
    const eventsStat = lstatSync(eventsPath, { bigint: true });
    const binding: VerifiedReadBinding = Object.freeze({
      projectionBinding: Object.freeze({
        projectId: manifest.projectId,
        vaultId: manifest.vaultId,
        storeId: manifest.storeId,
        workspaceId: manifest.workspaceId,
        branchScopeId: manifest.branchScopeId,
        branchRef: manifest.branchRef,
        sessionId: null,
      }),
      expectedRelease: release,
      controlGeneration: state.generation.toString(),
      session: sessionId ? Object.freeze({ sessionId, minimumEventPosition: "0" }) : null,
      eventsFile: Object.freeze({
        path: eventsPath,
        device: String(eventsStat.dev),
        inode: String(eventsStat.ino),
      }),
      projectionDirectory,
      executorStateDirectory,
      deploymentDirectory,
      compositionEpoch: `v2-mcp-${state.generation.toString()}`,
    });
    if (state.mode === "read-only-recovery") {
      const tailRow = this.#connection
        .prepare(
          `SELECT global_position, event_hash FROM events
           WHERE project_id = $projectId
           ORDER BY global_position DESC LIMIT 1`,
        )
        .get({ $projectId: this.#identity.projectId }) as
        | { global_position?: bigint; event_hash?: string }
        | undefined;
      const tailPosition = tailRow?.global_position ?? 0n;
      const tailHash = tailRow?.event_hash ?? GENESIS_GLOBAL_HASH;
      if (
        state.recoveryPosition === null
        || state.recoveryHash === null
        || state.recoveryPosition !== tailPosition
        || state.recoveryHash !== tailHash
      ) {
        throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
      }
      const bytes = readFileSync(
        join(this.#route.storeRoot, "projections", manifest.databaseFile),
      );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== manifest.databaseSha256) {
        throw new FreshStartError("FRESH_START_STORAGE_FAILURE");
      }
      const image = openImmutableProjectionImage(bytes);
      const fence = Object.freeze({
        releaseId: release.releaseId,
        controlGeneration: state.generation.toString(),
        capturedPosition: manifest.terminalEventPosition.toString(),
        capturedHash: manifest.terminalEventHash,
        requiredPosition: manifest.terminalEventPosition.toString(),
      });
      const ids = Object.freeze({
        requestId: randomUUID(),
        attemptId: randomUUID(),
        laneEpoch: binding.compositionEpoch,
      });
      const closed = Object.freeze({ image: true, reader: true, lock: true } as const);
      try {
        return await fn({
          queryFullNote: async (rawReq) => {
            const req = decodeGetFullNoteRequest(rawReq, binding.session);
            const receipt = decodeFullNoteVerifiedReadReceipt({
              operation: "get-full-note",
              consistency: req.consistency,
              scope: {
                ...binding.projectionBinding,
                sessionId: req.consistency === "session-strong" ? binding.session!.sessionId : null,
              },
              releaseId: fence.releaseId,
              controlGeneration: fence.controlGeneration,
              requiredEventPosition: fence.requiredPosition,
              projectionGeneration: manifest.generation,
              projectionEventPosition: manifest.terminalEventPosition.toString(),
              projectionEventHash: manifest.terminalEventHash,
              imageSha256: sha256,
              verification: "image-scope-position-and-active-admission",
              projectionSchemaVersion: 3,
            });
            const base = Object.freeze({
              version: 4 as const,
              ids,
              kind: "success" as const,
              receipt,
              fence,
              closed,
            });
            const candidate = queryNativeFullNote(image, manifest, {
              request: req,
              binding,
              receipt,
              remainingMs: req.budgetMs,
            });
            const content = buildNativeFullNoteResult(candidate, base);
            return Object.freeze({ receipt, content });
          },
          query: async (rawReq) => {
            const req = decodeVerifiedReadRequest(rawReq, binding.session);
            if (req.operation === "verify-published-view") {
              throw new FreshStartError("FRESH_START_INPUT_INVALID");
            }
            const receipt = decodeVerifiedReadReceipt({
              operation: req.operation,
              consistency: req.consistency,
              scope: {
                ...binding.projectionBinding,
                sessionId: req.consistency === "session-strong" ? binding.session!.sessionId : null,
              },
              releaseId: fence.releaseId,
              controlGeneration: fence.controlGeneration,
              requiredEventPosition: fence.requiredPosition,
              projectionGeneration: manifest.generation,
              projectionEventPosition: manifest.terminalEventPosition.toString(),
              projectionEventHash: manifest.terminalEventHash,
              imageSha256: sha256,
              verification: "image-scope-position-and-active-admission",
            });
            const base = Object.freeze({
              version: 3 as const,
              ids,
              kind: "success" as const,
              receipt,
              fence,
              closed,
            });
            const candidate = queryNativeContent(image, manifest, {
              request: req,
              binding,
              receipt,
              remainingMs: req.budgetMs,
            });
            const content = buildNativeContentResult(candidate, base);
            return Object.freeze({ receipt, content });
          },
        });
      } finally {
        image.close();
      }
    }
    const adapter = createVerifiedReadAdapter(binding);
    try {
      return await fn(adapter);
    } finally {
      await adapter.close();
    }
  }

  async #handleSessionStart(
    args: Record<string, unknown>,
    state: FreshStartState,
  ): Promise<Record<string, unknown>> {
    const started = await this.#startNewRootSession(
      typeof args.agentName === "string" ? args.agentName : "mcp-root",
    );
    return {
      ok: true,
      sessionId: started.sessionId,
      conversationId: started.conversationId,
      status: "active",
      mode: state.mode,
    };
  }

  async #handleLifecycleStatus(
    args: Record<string, unknown>,
    state: FreshStartState,
  ): Promise<Record<string, unknown>> {
    const sessionId =
      state.mode === "read-only-recovery"
        ? this.#resolveActiveRootSessionId(args.sessionId)
        : await this.#ensureActiveRootSession(args.sessionId);
    const row = sessionId
      ? this.#authorityRepo.get(this.#connection, this.#identity.projectId, sessionId)
      : null;
    return {
      ok: true,
      sessionId,
      status: row?.semanticState ?? "active",
      state: row?.semanticState ?? "active",
      ownerGeneration: row?.ownerGeneration?.toString() ?? "1",
      latestCheckpointId: row?.latestCheckpointId ?? null,
      mode: state.mode,
    };
  }

  async #handleSelfCheck(
    args: Record<string, unknown>,
    state: FreshStartState,
  ): Promise<Record<string, unknown>> {
    const sessionId =
      state.mode === "read-only-recovery"
        ? this.#resolveActiveRootSessionId(args.sessionId)
        : await this.#ensureActiveRootSession(args.sessionId);
    return {
      ok: true,
      sessionId,
      status: "healthy",
      taskSummary: typeof args.taskSummary === "string" ? args.taskSummary : null,
      mode: state.mode,
    };
  }

  async #handleWriteGovernedNote(
    recordKind: GovernedNoteKind,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sessionId = await this.#ensureActiveRootSession(args.sessionId);
    const hasExplicitTitle = typeof args.title === "string" && args.title.trim().length > 0;
    const title = hasExplicitTitle
      ? String(args.title).trim()
      : `Governed ${recordKind}`;
    const explicitSummary = typeof args.summary === "string" && args.summary.trim().length > 0
      ? args.summary.trim()
      : "";
    const rawSummary = explicitSummary.length > 0
      ? hasExplicitTitle && !explicitSummary.includes(title)
        ? `${title}: ${explicitSummary}`
        : explicitSummary
      : title;
    const body = typeof args.content === "string" && args.content.trim().length > 0
      ? args.content
      : typeof args.body === "string" && args.body.trim().length > 0
        ? args.body
        : `# ${title}\n\n${rawSummary}`;
    const confidence =
      args.confidence === "high"
      || args.confidence === "medium"
      || args.confidence === "low"
      || args.confidence === "guess"
        ? args.confidence
        : ("high" as const);

    const explicitProvenance =
      Array.isArray(args.provenance) && args.provenance.length > 0
        ? args.provenance
        : null;
    let provenance: unknown;
    let evidenceId: string | null = null;
    if (explicitProvenance !== null) {
      provenance = explicitProvenance;
      for (const entry of explicitProvenance) {
        if (
          typeof entry === "object"
          && entry !== null
          && (entry as { kind?: unknown }).kind === "retained-evidence"
          && typeof (entry as { identity?: unknown }).identity === "string"
        ) {
          evidenceId = (entry as { identity: string }).identity;
          break;
        }
      }
    } else {
      const retained = this.#retainEvidenceForSession(
        sessionId,
        `${title}\n${rawSummary}\n${body}`,
      );
      evidenceId = retained.evidenceIds[0]!;
      provenance = [{ kind: "retained-evidence", identity: evidenceId }];
    }

    const command = decodeGovernedNoteCommandV2({
      version: 2,
      operation: "create-governed-note",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      recordKind,
      summary: rawSummary,
      confidence,
      provenance,
      content: {
        format: "markdown",
        body,
      },
    });
    const noteBinding = deriveGovernedNoteBinding(
      this.#connection,
      this.#rootContext,
      sessionId,
    );
    const proof = this.#mintProof(sessionId, this.#rootContext, (scope) =>
      governedNoteCreateProofTargetV2(command, scope, noteBinding, randomUUID()),
    );
    const created = this.#governedNoteRuntime.createV2(
      {
        command,
        authorization: {
          kind: "protected",
          authoritySessionId: sessionId as SessionId,
          targetSessionId: sessionId as SessionId,
          proof,
          approval: null,
          childBindingGrant: null,
        },
      },
      this.#rootContext,
    );

    await this.#publishProjectionV3();
    return {
      ok: true,
      recordId: created.response.recordId,
      recordKind: created.response.recordKind,
      status: created.response.status,
      verificationStatus: created.response.verificationStatus,
      eventId: created.response.sourceEventIds[0],
      sourceEventIds: created.response.sourceEventIds,
      evidenceId,
      bodyContentHash: created.response.content.contentHash,
      terminalPosition: created.response.terminalPosition,
    };
  }

  #resolveNoteSessionId(recordId: string, explicitSessionId?: unknown): string | null {
    if (typeof explicitSessionId === "string" && explicitSessionId.trim().length > 0) {
      return explicitSessionId.trim();
    }
    const rows = this.#connection
      .prepare(
        `SELECT session_id, payload_json FROM events
         WHERE project_id = $projectId AND event_type IN ('GovernedNoteCreated', 'MemorySourceRecorded')
         ORDER BY global_position DESC`,
      )
      .all({ $projectId: this.#identity.projectId }) as Array<{
      session_id?: string | null;
      payload_json: string;
    }>;
    for (const row of rows) {
      if (row.payload_json.includes(recordId) && typeof row.session_id === "string") {
        return row.session_id;
      }
    }
    return this.#resolveActiveRootSessionId();
  }

  async #handleGetFullNote(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const id = String(args.id ?? args.recordId ?? args.noteId ?? "").trim();
    if (!id) throw new FreshStartError("FRESH_START_INPUT_INVALID");
    const sessionId = this.#resolveNoteSessionId(id, args.sessionId);
    return this.#withVerifiedReadAdapter(state, release, sessionId, async (adapter) => {
      const res = await adapter.queryFullNote({
        operation: "get-full-note",
        consistency: sessionId ? "session-strong" : "project-strong",
        minimumEventPosition: "0",
        budgetMs: 5000,
        parameters: { id },
      });
      if (!res.content.item) {
        return {
          ok: false,
          id,
          recordId: id,
          found: false,
        };
      }
      return {
        ok: true,
        recordId: res.content.item.id,
        ...res.content.item,
        conflict: res.content.conflict,
      };
    });
  }

  async #handleSearch(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const query = String(args.query ?? args.area ?? "").trim() || "governed";
    const limit = typeof args.limit === "number" ? args.limit : 10;
    const sessionId = this.#resolveActiveRootSessionId(args.sessionId);
    return this.#withVerifiedReadAdapter(state, release, sessionId, async (adapter) => {
      const res = await adapter.query({
        operation: "search-projected-content",
        consistency: sessionId ? "session-strong" : "project-strong",
        minimumEventPosition: "0",
        budgetMs: 5000,
        parameters: { query, limit },
      });
      return {
        ok: true,
        ...res.content,
      };
    });
  }

  async #handleList(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const sessionId = this.#resolveActiveRootSessionId(args.sessionId);
    return this.#withVerifiedReadAdapter(state, release, sessionId, async (adapter) => {
      const res = await adapter.query({
        operation: "list-canonical-records",
        consistency: sessionId ? "session-strong" : "project-strong",
        minimumEventPosition: "0",
        budgetMs: 5000,
        parameters: { limit },
      });
      const content = res.content as NativeCanonicalPageResult;
      const items = content.items.map((entry) => ({
        ...entry.item,
        conflict: entry.conflict,
      }));
      return {
        ok: true,
        items,
        hasMore: content.hasMore,
        nextCursor: content.nextCursor,
      };
    });
  }

  async #handleRecent(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const sessionId = this.#resolveActiveRootSessionId(args.sessionId);
    return this.#withVerifiedReadAdapter(state, release, sessionId, async (adapter) => {
      const res = await adapter.query({
        operation: "recent-canonical-records",
        consistency: sessionId ? "session-strong" : "project-strong",
        minimumEventPosition: "0",
        budgetMs: 5000,
        parameters: { limit },
      });
      const content = res.content as NativeCanonicalPageResult;
      const items = content.items.map((entry) => ({
        ...entry.item,
        conflict: entry.conflict,
      }));
      return {
        ok: true,
        items,
        hasMore: content.hasMore,
        nextCursor: content.nextCursor,
      };
    });
  }

  async #handleContextPack(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const query = String(args.area ?? args.query ?? args.task ?? "context").trim() || "context";
    const sessionId = this.#resolveActiveRootSessionId(args.sessionId);
    return this.#withVerifiedReadAdapter(state, release, sessionId, async (adapter) => {
      const res = await adapter.query({
        operation: "build-context-pack",
        consistency: sessionId ? "session-strong" : "project-strong",
        minimumEventPosition: "0",
        budgetMs: 5000,
        parameters: { query },
      });
      return {
        ok: true,
        generation: res.receipt.projectionGeneration,
        ...res.content,
      };
    });
  }

  async #handleFollowUpRadar(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const limit = typeof args.limit === "number" ? args.limit : 10;
    const sessionId = this.#resolveActiveRootSessionId(args.sessionId);
    return this.#withVerifiedReadAdapter(state, release, sessionId, async (adapter) => {
      const res = await adapter.query({
        operation: "follow-up-radar",
        consistency: sessionId ? "session-strong" : "project-strong",
        minimumEventPosition: "0",
        budgetMs: 5000,
        parameters: { limit },
      });
      return {
        ok: true,
        ...res.content,
      };
    });
  }

  async #handleAwaken(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const sessionId =
      state.mode === "read-only-recovery"
        ? this.#resolveActiveRootSessionId(args.sessionId)
        : await this.#ensureActiveRootSession(args.sessionId);
    const contextPack = await this.#handleContextPack(
      sessionId ? { ...args, sessionId } : args,
      state,
      release,
    );
    return {
      ok: true,
      sessionId,
      mode: state.mode,
      contextPack,
    };
  }

  async #handleVerifyVault(release: FreshStartRelease): Promise<Record<string, unknown>> {
    const integrity = new EventIntegrityService(this.#connection).quickCheck(this.#rootContext);
    const manifest = await this.#publishProjectionV3();
    return {
      ok: integrity.ok,
      status: integrity.ok ? "healthy" : "unhealthy",
      issues: integrity.issues,
      projectionGeneration: manifest.generation,
      projectionSchemaVersion: manifest.schemaVersion,
      buildIdentityHash: release.buildIdentityHash,
      checkedEvents: String(integrity.eventsVerified),
    };
  }

  async #handleVerifyNote(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const id = String(args.id ?? args.recordId ?? args.noteId ?? "").trim();
    if (!id) throw new FreshStartError("FRESH_START_INPUT_INVALID");
    const repo = new GovernedNoteRepository(this.#connection);
    const row = this.#connection
      .prepare(
        `SELECT command_id, idempotency_key FROM events
         WHERE project_id = $projectId AND event_type = 'GovernedNoteCreated' AND payload_json LIKE $pattern
         ORDER BY global_position DESC LIMIT 1`,
      )
      .get({
        $projectId: this.#identity.projectId,
        $pattern: `%${id}%`,
      }) as { command_id?: string; idempotency_key?: string } | undefined;

    if (row?.command_id && row.idempotency_key) {
      const prior = repo.findGovernedNotePriorAny(row.command_id, row.idempotency_key);
      if (prior) {
        validateGovernedNotePairAny(prior.events, prior.result);
      }
    }

    const fullNote = await this.#handleGetFullNote({ id }, state, release);
    return {
      ok: Boolean(fullNote.ok),
      recordId: id,
      verified: Boolean(fullNote.ok),
      note: fullNote,
    };
  }

  async #handleVerifySourceTruth(release: FreshStartRelease): Promise<Record<string, unknown>> {
    const headRow = this.#connection
      .prepare("SELECT COUNT(*) AS count, MAX(global_position) AS pos FROM events")
      .get() as { count?: bigint; pos?: bigint | null } | undefined;
    return {
      ok: true,
      projectId: this.#identity.projectId,
      vaultId: this.#identity.vaultId,
      storeId: this.#identity.storeId,
      workspaceId: this.#workspace.workspaceId,
      buildIdentityHash: release.buildIdentityHash,
      eventCount: (headRow?.count ?? 0n).toString(),
      terminalEventPosition: (headRow?.pos ?? 0n).toString(),
    };
  }

  async #withProjectedImage<T>(fn: (db: DatabaseSync) => T): Promise<T> {
    const manifest = await this.#publishProjectionV3();
    const projectionDir = join(this.#route.storeRoot, "projections");
    const bytes = readFileSync(join(projectionDir, manifest.databaseFile));
    const db = openImmutableProjectionImage(bytes);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  async #handleFindDuplicates(): Promise<Record<string, unknown>> {
    return this.#withProjectedImage((db) => {
      const rows = db
        .prepare(
          `SELECT item_id, normalized_key, summary, content_hash
           FROM canonical_items
           WHERE status NOT IN ('retracted', 'superseded', 'erased-evidence')
           ORDER BY item_id ASC`,
        )
        .all() as Array<{
        item_id: string;
        normalized_key: string;
        summary: string;
        content_hash: string;
      }>;
      const byHash = new Map<string, string[]>();
      for (const row of rows) {
        const list = byHash.get(row.content_hash) ?? [];
        list.push(row.item_id);
        byHash.set(row.content_hash, list);
      }
      const duplicateGroups = [...byHash.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([contentHash, recordIds]) => ({ contentHash, recordIds }));
      return {
        ok: true,
        duplicateGroups,
      };
    });
  }

  async #handleCheckStaleness(): Promise<Record<string, unknown>> {
    return this.#withProjectedImage((db) => {
      const rows = db
        .prepare(
          `SELECT item_id, normalized_key, status, valid_to, summary
           FROM canonical_items
           WHERE status IN ('expired', 'superseded', 'retracted', 'conflicted')
              OR (valid_to IS NOT NULL AND valid_to <= $now)
           ORDER BY item_id ASC`,
        )
        .all({ $now: new Date().toISOString() }) as Array<{
        item_id: string;
        normalized_key: string;
        status: string;
        valid_to: string | null;
        summary: string;
      }>;
      return {
        ok: true,
        staleItems: rows.map((r) => ({
          id: r.item_id,
          recordId: r.item_id,
          normalizedKey: r.normalized_key,
          status: r.status,
          validTo: r.valid_to,
          summary: r.summary,
        })),
      };
    });
  }

  async #handlePromote(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const recordId = String(args.recordId ?? args.id ?? "").trim();
    if (!recordId) throw new FreshStartError("FRESH_START_INPUT_INVALID");
    const rawMethod = String(args.verificationMethod ?? "user-confirmed").trim();
    const verificationMethod: GovernedVerificationPolicyMethodV1 =
      rawMethod === "manual-review" || rawMethod === "operator-approved"
        ? "user-confirmed"
        : (rawMethod as GovernedVerificationPolicyMethodV1);
    const requestedStatus = String(args.targetStatus ?? "active").trim();
    const targetStatus: "provisional" | "verified" | "conflicted" =
      requestedStatus === "provisional"
        ? "provisional"
        : requestedStatus === "conflicted"
          ? "conflicted"
          : "verified";
    const verificationAnchor = String(
      args.verificationAnchor ?? args.reason ?? "mcp-operator-verified",
    );

    const receipt = this.#governanceService.promote({
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      recordId,
      targetStatus,
      verificationMethod,
      verificationAnchor,
      reason: typeof args.reason === "string" ? args.reason : undefined,
      conflictKey: typeof args.conflictKey === "string" ? args.conflictKey : null,
    });
    return {
      ok: true,
      ...serializeMutationReceipt(receipt),
      status: requestedStatus === "active" ? "active" : receipt.targetStatus,
    };
  }

  async #handleSupersede(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const recordId = String(args.recordId ?? args.id ?? "").trim();
    const supersedingRecordId =
      typeof args.supersedingRecordId === "string"
        ? args.supersedingRecordId
        : typeof args.replacementRecordId === "string"
          ? args.replacementRecordId
          : null;
    const reason = String(args.reason ?? "Superseded via V2 MCP tool");
    const receipt = this.#governanceService.supersede({
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      recordId,
      supersedingRecordId,
      reason,
      declareConflict: args.declareConflict === true,
      conflictKey: typeof args.conflictKey === "string" ? args.conflictKey : null,
    });
    return {
      ok: true,
      ...serializeMutationReceipt(receipt),
      status: receipt.targetStatus,
    };
  }

  async #handleRetract(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const recordId = String(args.recordId ?? args.id ?? "").trim();
    const reason = String(args.reason ?? "Retracted via V2 MCP tool");
    const receipt = this.#governanceService.retract({
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      recordId,
      reason,
    });
    return {
      ok: true,
      ...serializeMutationReceipt(receipt),
      status: receipt.targetStatus,
    };
  }

  async #handleExpire(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const recordId = String(args.recordId ?? args.id ?? "").trim();
    const validTo = String(args.validTo ?? new Date().toISOString());
    const reason = String(args.reason ?? "Expired via V2 MCP tool");
    const receipt = this.#governanceService.expire({
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      recordId,
      validTo,
      reason,
    });
    return {
      ok: true,
      ...serializeMutationReceipt(receipt),
      status: receipt.targetStatus,
    };
  }

  async #handleRecordEvidenceBatch(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sessionId = await this.#ensureActiveRootSession(args.sessionId);
    const content = String(args.content ?? "Retained conversation evidence frame");
    const conversationId =
      typeof args.conversationId === "string" && args.conversationId.length > 0
        ? args.conversationId
        : randomUUID();
    const retained = this.#retainEvidenceForSession(sessionId, content, conversationId);
    return {
      ok: true,
      sessionId,
      conversationId: retained.conversationId,
      evidenceIds: retained.evidenceIds,
      eventIds: retained.eventIds,
    };
  }

  async #handleForgetEvidence(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const evidenceIds = Array.isArray(args.evidenceIds)
      ? args.evidenceIds.map(String)
      : typeof args.evidenceId === "string"
        ? [args.evidenceId]
        : [];
    const recordIds = Array.isArray(args.recordIds)
      ? args.recordIds.map(String)
      : typeof args.recordId === "string"
        ? [args.recordId]
        : [];
    const reason = String(args.reason ?? "Cryptographic evidence erasure");

    if (evidenceIds.length > 0 || recordIds.length > 0) {
      const receipt = this.#governanceService.forgetEvidence({
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        evidenceIds,
        recordIds,
        reason,
      });
      return {
        ok: true,
        forgotten: true,
        ...serializeMutationReceipt(receipt),
        erasedEvidenceIds: receipt.erasedEvidenceIds,
        erasedRecordIds: receipt.erasedRecordIds,
      };
    }

    const currentWrapVersion =
      this.#custody
        .inspectKeyVersions()
        .find((k) => k.family === "evidence" && k.purpose === "data-key-wrap" && k.isCurrent)
        ?.version ?? "1";
    const nextVersion = (BigInt(currentWrapVersion) + 1n).toString();
    const rotated = this.#custody.rotateEvidenceWrapKey(nextVersion);
    return {
      ok: true,
      forgotten: true,
      purpose: String(args.purpose ?? "data-key-wrap"),
      reason,
      rotatedEnvelopes: rotated.rotatedEnvelopes,
      activeKeyRef: rotated.activeKeyRef,
    };
  }

  #currentSessionStreamVersion(sessionId: string): string {
    const row = this.#connection
      .prepare("SELECT current_version FROM streams WHERE stream_id = $id")
      .get({ $id: `session/${sessionId}` }) as { current_version?: bigint } | undefined;
    return (row?.current_version ?? 0n).toString();
  }

  #currentGlobalPosition(): string {
    const row = this.#connection
      .prepare("SELECT MAX(global_position) AS pos FROM events")
      .get() as { pos?: bigint | null } | undefined;
    return (row?.pos ?? 0n).toString();
  }

  async #handleCheckpoint(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = await this.#ensureActiveRootSession(args.sessionId);
    const taskSummary = String(
      args.taskSummary ?? args.summary ?? "Session lifecycle checkpoint",
    );
    const b = this.#rootContext.binding;
    const authority = this.#authorityRepo.get(this.#connection, b.projectId, sessionId)!;
    const generation = authority.ownerGeneration!.toString();
    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "record-checkpoint",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: this.#projectionBinding.branchRef,
      sessionId,
      expectedStreamVersion: this.#currentSessionStreamVersion(sessionId),
      expectedBaseEventPosition: this.#currentGlobalPosition(),
      draft: emptyCheckpointDraftV2(taskSummary) as unknown as JsonValue,
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "protected",
      authorizationSessionId: sessionId,
      targetSessionId: sessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: generation,
    });
    const proof = this.#mintProof(sessionId, this.#rootContext, (scope) => ({
      ...scope,
      proofVersion: 1,
      target: "semantic-command",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: witness.intentHash,
      proofNonce: randomUUID(),
    }));
    await this.#lifecycleRuntime.execute(
      decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "record-checkpoint",
        prepared: {
          command,
          candidateIntentHash: witness.intentHash,
          authorization: {
            kind: "protected",
            authoritySessionId: sessionId as SessionId,
            targetSessionId: sessionId as SessionId,
            proof,
            approval: null,
            childBindingGrant: null,
          },
        },
      }),
      this.#rootContext,
    );
    const updated = this.#authorityRepo.get(this.#connection, b.projectId, sessionId)!;
    return {
      ok: true,
      sessionId,
      checkpointId: updated.latestCheckpointId,
      checkpointEventPosition: updated.latestCheckpointEventPosition?.toString() ?? null,
      checkpointFingerprint: updated.latestCheckpointFingerprint,
    };
  }

  async #handleSessionFork(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parentSessionId = await this.#ensureActiveRootSession(
      args.parentSessionId ?? args.sessionId,
    );
    const b = this.#rootContext.binding;
    const authority = this.#authorityRepo.get(this.#connection, b.projectId, parentSessionId)!;
    const childSessionId = randomUUID();
    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "fork-child",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: this.#projectionBinding.branchRef,
      parentSessionId,
      expectedStreamVersion: this.#currentSessionStreamVersion(parentSessionId),
      assignment: {
        assignmentId: randomUUID(),
        summary: String(args.summary ?? "Subagent child session"),
        scope: String(args.scope ?? "v2-mcp-child"),
      },
      directAccessRequested: false,
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "protected",
      authorizationSessionId: parentSessionId,
      targetSessionId: parentSessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: authority.ownerGeneration!.toString(),
    });
    const proof = this.#mintProof(parentSessionId, this.#rootContext, (scope) => ({
      ...scope,
      proofVersion: 1,
      target: "semantic-command",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: witness.intentHash,
      proofNonce: randomUUID(),
    }));
    this.#nextUuid = childSessionId;
    try {
      const executed = await this.#lifecycleRuntime.execute(
        decodeLifecycleWorkerOperationWire({
          kind: "semantic",
          operation: "fork-child",
          prepared: {
            command,
            candidateIntentHash: witness.intentHash,
            authorization: {
              kind: "protected",
              authoritySessionId: parentSessionId as SessionId,
              targetSessionId: parentSessionId as SessionId,
              proof,
              approval: null,
              childBindingGrant: null,
            },
          },
        }),
        this.#rootContext,
      );
      const pub = (
        executed.result as unknown as {
          publicResult: {
            childSessionId: string;
            parentSessionId: string;
            state: string;
            eventPosition: string;
          };
        }
      ).publicResult;
      return {
        ok: true,
        parentSessionId: pub.parentSessionId,
        childSessionId: pub.childSessionId,
        state: pub.state,
        eventPosition: pub.eventPosition,
      };
    } finally {
      this.#nextUuid = undefined;
    }
  }

  async #handleRecordChildResult(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parentSessionId = await this.#ensureActiveRootSession(args.parentSessionId);
    const childSessionId = String(args.childSessionId ?? "").trim();
    if (!childSessionId) throw new FreshStartError("FRESH_START_INPUT_INVALID");
    const b = this.#rootContext.binding;
    const rootAuthority = this.#authorityRepo.get(this.#connection, b.projectId, parentSessionId)!;
    const findings = Array.isArray(args.findings)
      ? args.findings.map((entry) =>
          typeof entry === "object" && entry !== null && "summary" in entry
            ? entry
            : {
                summary: String(entry),
                evidenceReferences: [],
                confidence: "high" as const,
              },
        )
      : [];
    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "record-child-report",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: this.#projectionBinding.branchRef,
      parentSessionId,
      childSessionId,
      childAuthorAgentId: "v2-mcp-agent",
      expectedStreamVersion: this.#currentSessionStreamVersion(childSessionId),
      report: {
        reportVersion: 1,
        outcomeSummary: String(args.outcomeSummary ?? args.summary ?? "Child task completed"),
        findings,
        proposedDecisions: [],
        filesObservedOrChanged: [],
        verificationPerformed: [],
        openFollowUps: [],
        blockers: [],
        evidenceFingerprints: [],
      },
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "protected",
      authorizationSessionId: parentSessionId,
      targetSessionId: childSessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: rootAuthority.ownerGeneration!.toString(),
    });
    const proof = this.#mintProof(parentSessionId, this.#rootContext, (scope) => ({
      ...scope,
      targetSessionId: childSessionId as SessionId,
      proofVersion: 1,
      target: "semantic-command",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: witness.intentHash,
      proofNonce: randomUUID(),
    }));
    const executed = await this.#lifecycleRuntime.execute(
      decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "record-child-report",
        prepared: {
          command,
          candidateIntentHash: witness.intentHash,
          authorization: {
            kind: "protected",
            authoritySessionId: parentSessionId as SessionId,
            targetSessionId: childSessionId as SessionId,
            proof,
            approval: null,
            childBindingGrant: null,
          },
        },
      }),
      this.#rootContext,
    );
    const pub = (
      executed.result as unknown as {
        publicResult: {
          parentSessionId: string;
          childSessionId: string;
          reportId: string;
          state: string;
          eventPosition: string;
        };
      }
    ).publicResult;
    return {
      ok: true,
      parentSessionId: pub.parentSessionId,
      childSessionId: pub.childSessionId,
      reportId: pub.reportId,
      state: pub.state,
      eventPosition: pub.eventPosition,
    };
  }

  async #handleCompleteChildSession(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const parentSessionId = await this.#ensureActiveRootSession(args.parentSessionId);
    const childSessionId = String(args.childSessionId ?? "").trim();
    const reportId = String(args.reportId ?? "").trim();
    if (!childSessionId || !reportId) {
      throw new FreshStartError("FRESH_START_INPUT_INVALID");
    }
    const b = this.#rootContext.binding;
    const rootAuthority = this.#authorityRepo.get(this.#connection, b.projectId, parentSessionId)!;
    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "complete-child-session",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: this.#projectionBinding.branchRef,
      parentSessionId,
      childSessionId,
      expectedStreamVersion: this.#currentSessionStreamVersion(childSessionId),
      reportId,
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "protected",
      authorizationSessionId: parentSessionId,
      targetSessionId: childSessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: rootAuthority.ownerGeneration!.toString(),
    });
    const proof = this.#mintProof(parentSessionId, this.#rootContext, (scope) => ({
      ...scope,
      targetSessionId: childSessionId as SessionId,
      proofVersion: 1,
      target: "semantic-command",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: witness.intentHash,
      proofNonce: randomUUID(),
    }));
    const executed = await this.#lifecycleRuntime.execute(
      decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "complete-child-session",
        prepared: {
          command,
          candidateIntentHash: witness.intentHash,
          authorization: {
            kind: "protected",
            authoritySessionId: parentSessionId as SessionId,
            targetSessionId: childSessionId as SessionId,
            proof,
            approval: null,
            childBindingGrant: null,
          },
        },
      }),
      this.#rootContext,
    );
    const pub = (
      executed.result as unknown as {
        publicResult: {
          parentSessionId: string;
          childSessionId: string;
          reportId: string;
          state: string;
          eventPosition: string;
        };
      }
    ).publicResult;
    return {
      ok: true,
      parentSessionId: pub.parentSessionId,
      childSessionId: pub.childSessionId,
      reportId: pub.reportId,
      state: pub.state,
      eventPosition: pub.eventPosition,
    };
  }

  async #handleRecoverSession(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = await this.#ensureActiveRootSession(args.sessionId);
    const b = this.#rootContext.binding;
    await this.#handleCheckpoint({
      sessionId,
      taskSummary: "Pre-recovery checkpoint",
    });
    const authority = this.#authorityRepo.get(this.#connection, b.projectId, sessionId)!;

    const expectedOwnerGeneration = authority.ownerGeneration!.toString();
    const reasonCode =
      args.reasonCode === "credential-loss"
      || args.reasonCode === "suspected-compromise"
      || args.reasonCode === "irrecoverable-session"
        ? args.reasonCode
        : "explicit-user-approval";

    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "root-recovery",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: this.#projectionBinding.branchRef,
      sessionId,
      expectedOwnerGeneration,
      preTransitionCheckpointId: authority.latestCheckpointId!,
      reasonCode,
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "protected",
      authorizationSessionId: sessionId,
      targetSessionId: sessionId,
      capabilityKind: null,
      capabilityGeneration: null,
    });

    const nowMs = BigInt(Date.now());
    const issuedAt = new Date(Number(nowMs)).toISOString();
    const expiresAt = new Date(Number(nowMs + 300_000n)).toISOString();
    const keyId = this.#custody.capability.currentKey(
      { projectId: b.projectId, storeId: b.storeId },
      "recovery-approval",
    ).keyId;
    const approvalSecret = issueRecoveryApproval(this.#custody.capability, {
      approvalVersion: 1,
      approvalId: randomUUID(),
      keyId,
      action: "recover-root-authority",
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      sessionId,
      expectedOwnerGeneration,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: witness.intentHash,
      executorActorRole: "primary",
      executorClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      issuedAt,
      expiresAt,
      approvalNonce: randomBytes(32).toString("hex"),
      reasonCode,
      redactedApprovalReference: `mcp-recovery/${command.commandId}`,
    });
    let redactedApproval;
    try {
      redactedApproval = verifyRecoveryApproval(
        this.#custody.capability,
        approvalSecret,
        {
          action: "recover-root-authority",
          projectId: b.projectId,
          vaultId: b.vaultId,
          storeId: b.storeId,
          workspaceId: b.workspaceId,
          sessionId,
          expectedOwnerGeneration,
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          intentHash: witness.intentHash,
          executorActorRole: "primary",
          executorClientInstanceId: b.clientInstanceId,
          targetActorRole: "primary",
          targetClientInstanceId: b.clientInstanceId,
        },
        nowMs,
      ).redacted;
    } finally {
      approvalSecret.destroy();
    }

    await this.#lifecycleRuntime.execute(
      decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "root-recovery",
        prepared: {
          command,
          candidateIntentHash: witness.intentHash,
          authorization: {
            kind: "protected",
            authoritySessionId: sessionId as SessionId,
            targetSessionId: sessionId as SessionId,
            proof: null,
            approval: redactedApproval,
            childBindingGrant: null,
          },
        },
      }),
      this.#rootContext,
    );

    // Record a post-recovery checkpoint so checkpointRequiredReason is cleared for subsequent session-end operations
    await this.#handleCheckpoint({
      sessionId,
      taskSummary: "Post-recovery checkpoint",
    });
    const recoveredAuthority = this.#authorityRepo.get(this.#connection, b.projectId, sessionId)!;
    return {
      ok: true,
      sessionId,
      ownerGeneration: recoveredAuthority.ownerGeneration?.toString() ?? "2",
      state: recoveredAuthority.semanticState,
    };
  }

  async #handleSessionEnd(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = await this.#ensureActiveRootSession(args.sessionId);
    const b = this.#rootContext.binding;
    await this.#handleCheckpoint({
      sessionId,
      taskSummary: String(args.summary ?? "Pre-session-end checkpoint"),
    });
    const authority = this.#authorityRepo.get(this.#connection, b.projectId, sessionId)!;

    const summary = String(args.summary ?? "Requesting session end");
    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "request-session-end",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: this.#projectionBinding.branchRef,
      request: {
        requestVersion: 2,
        sessionId,
        childEndPolicy: "require-completed",
        finalCheckpoint: emptyCheckpointDraftV2(summary),
        validationProfileIds: [],
        requestedQualityThreshold: 0,
        requireFullEvidence: false,
        requireMaterialization: false,
      },
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "protected",
      authorizationSessionId: sessionId,
      targetSessionId: sessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: authority.ownerGeneration!.toString(),
    });
    const proof = this.#mintProof(sessionId, this.#rootContext, (scope) => ({
      ...scope,
      proofVersion: 1,
      target: "semantic-command",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: witness.intentHash,
      proofNonce: randomUUID(),
    }));
    const executed = await this.#lifecycleRuntime.execute(
      decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "request-session-end",
        prepared: {
          command,
          candidateIntentHash: witness.intentHash,
          authorization: {
            kind: "protected",
            authoritySessionId: sessionId as SessionId,
            targetSessionId: sessionId as SessionId,
            proof,
            approval: null,
            childBindingGrant: null,
          },
        },
      }),
      this.#rootContext,
    );
    const pub = (
      executed.result as unknown as {
        publicResult: Record<string, unknown>;
      }
    ).publicResult;
    return {
      ok: true,
      ...pub,
    };
  }

  async #handleAmendSessionEnd(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = await this.#ensureActiveRootSession(args.sessionId);
    const workflowId = String(args.workflowId ?? "").trim();
    if (!workflowId) throw new FreshStartError("FRESH_START_INPUT_INVALID");
    const b = this.#rootContext.binding;
    const authority = this.#authorityRepo.get(this.#connection, b.projectId, sessionId)!;
    const summary = String(args.summary ?? "Amended final checkpoint summary");
    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "amend-session-end",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: this.#projectionBinding.branchRef,
      sessionId,
      workflowId,
      expectedStreamVersion: this.#currentSessionStreamVersion(sessionId),
      amendment: {
        amendmentVersion: 2,
        childEndPolicy: null,
        finalCheckpoint: emptyCheckpointDraftV2(summary),
        validationProfileIds: null,
        requestedQualityThreshold: null,
        requireFullEvidence: null,
        requireMaterialization: null,
        evidenceWindowAction: "unchanged",
      },
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "protected",
      authorizationSessionId: sessionId,
      targetSessionId: sessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: authority.ownerGeneration!.toString(),
    });
    const proof = this.#mintProof(sessionId, this.#rootContext, (scope) => ({
      ...scope,
      proofVersion: 1,
      target: "semantic-command",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: witness.intentHash,
      proofNonce: randomUUID(),
    }));
    const executed = await this.#lifecycleRuntime.execute(
      decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "amend-session-end",
        prepared: {
          command,
          candidateIntentHash: witness.intentHash,
          authorization: {
            kind: "protected",
            authoritySessionId: sessionId as SessionId,
            targetSessionId: sessionId as SessionId,
            proof,
            approval: null,
            childBindingGrant: null,
          },
        },
      }),
      this.#rootContext,
    );
    const pub = (
      executed.result as unknown as {
        publicResult: Record<string, unknown>;
      }
    ).publicResult;
    return {
      ok: true,
      ...pub,
    };
  }

  async #handleCancelSessionEnd(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = await this.#ensureActiveRootSession(args.sessionId);
    const workflowId = String(args.workflowId ?? "").trim();
    if (!workflowId) throw new FreshStartError("FRESH_START_INPUT_INVALID");
    const b = this.#rootContext.binding;
    const authority = this.#authorityRepo.get(this.#connection, b.projectId, sessionId)!;
    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "cancel-session-end",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: this.#projectionBinding.branchRef,
      sessionId,
      workflowId,
      expectedStreamVersion: this.#currentSessionStreamVersion(sessionId),
      preTransitionCheckpointId: authority.latestCheckpointId!,
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "protected",
      authorizationSessionId: sessionId,
      targetSessionId: sessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: authority.ownerGeneration!.toString(),
    });
    const proof = this.#mintProof(sessionId, this.#rootContext, (scope) => ({
      ...scope,
      proofVersion: 1,
      target: "semantic-command",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: witness.intentHash,
      proofNonce: randomUUID(),
    }));
    const executed = await this.#lifecycleRuntime.execute(
      decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "cancel-session-end",
        prepared: {
          command,
          candidateIntentHash: witness.intentHash,
          authorization: {
            kind: "protected",
            authoritySessionId: sessionId as SessionId,
            targetSessionId: sessionId as SessionId,
            proof,
            approval: null,
            childBindingGrant: null,
          },
        },
      }),
      this.#rootContext,
    );
    const pub = (
      executed.result as unknown as {
        publicResult: Record<string, unknown>;
      }
    ).publicResult;
    return {
      ok: true,
      ...pub,
    };
  }
}
