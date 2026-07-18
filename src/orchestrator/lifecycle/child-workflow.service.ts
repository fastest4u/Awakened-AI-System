import type {
  JsonValue,
  LifecycleReplayExpectation,
  PendingEvent,
  PersistedLifecycleAuthorizationRecord,
} from "../contracts/event.js";
import type { ProjectContext } from "../identity/contracts.js";
import type {
  ChildAuthorityInsert,
  ChildTransferTicketInsert,
  SessionAuthorityMutation,
  SessionAuthorityRecord,
} from "../storage/lifecycle-storage.types.js";
import type { ChildTransferRepository } from "../storage/child-transfer.repository.js";
import type { SessionAuthorityRepository } from "../storage/session-authority.repository.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import { PREVIOUS_PENDING_EVENT_CAUSATION } from "../storage/event-append-transaction.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import {
  authorityCommitment,
  type CommittedAuthorityV1,
} from "./authority/authority-commitment.js";
import type {
  WorkerAuthorityMaterialResultV1,
  WorkerLifecycleResult,
} from "./authority/authority-material-adapter.js";
import {
  capabilityProofDigest,
  type SemanticCommandProofTargetV1,
} from "./authority/capability-codec.js";
import {
  CapabilityService,
  type StoredCapabilityMaterialV1,
} from "./capability.service.js";
import {
  decodeChildReportV1,
  type ChildReportDraftV1,
  type ChildReportItemDraftV1,
  type ChildReportItemV1,
  type ChildReportV1,
} from "./contracts/child.js";
import {
  assertSemanticCommandAuthorization,
  decodeLifecycleSemanticCommandDraft,
  type AmendChildAssignmentCommandV2,
  type ChildBindingGrantV1,
  type ClaimChildTransferCommandV2,
  type CompleteChildSessionCommandV2,
  type DispositionChildReportCommandV2,
  type ForkChildCommandV2,
  type LifecycleSemanticCommandDraft,
  type PreparedLifecycleWorkerCommand,
  type ProposeChildCompletionCommandV2,
  type RecordChildReportCommandV2,
  type SuspendChildSessionCommandV2,
} from "./contracts/commands.js";
import type { LifecycleEventV1 } from "./contracts/events.js";
import type {
  ChildSessionState,
  ReportId,
  ReportItemId,
  SessionId,
  TransferTicketId,
} from "./contracts/identifiers.js";
import { LifecycleError } from "./errors.js";
import {
  LifecycleCommandStore,
  type LifecycleCommandTransaction,
  type PreparedLifecycleCommit,
} from "./lifecycle-command.store.js";
import { buildLifecycleIntentWitness } from "./lifecycle-intent-witness.js";
import type { ChildAggregateState, SessionAggregateState } from "./session-aggregate.js";
import { requireRiskyTransitionCheckpointV1 } from "./checkpoint.service.js";

const LOWER_HASH = /^[0-9a-f]{64}$/;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const REPORT_FIELDS = [
  "findings",
  "proposedDecisions",
  "filesObservedOrChanged",
  "verificationPerformed",
  "openFollowUps",
  "blockers",
] as const;

type ChildCommand = Extract<LifecycleSemanticCommandDraft, {
  readonly commandType:
    | "fork-child"
    | "amend-child-assignment"
    | "record-child-report"
    | "disposition-child-report"
    | "propose-child-completion"
    | "complete-child-session"
    | "suspend-child-session"
    | "claim-child-transfer";
}>;

export type ChildWorkflowResultV2 = JsonValue & {
  readonly resultVersion: 2;
  readonly operation: ChildCommand["commandType"];
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly directAccessEnabled?: boolean;
  readonly rootOwnerGeneration?: string;
  readonly assignment?: { readonly assignmentId: string; readonly summary: string; readonly scope: string };
  readonly assignmentRevision?: string;
  readonly reportId?: string;
  readonly reportItemIds?: string[];
  readonly disposition?: { readonly kind: string; readonly reportId: string };
  readonly state?: string;
  readonly transferTicketId?: string;
  readonly previousChildSessionId?: string;
  readonly eventPosition: string;
  readonly finalStreamVersion: string;
};

export type ForkChildResultV2 = ChildWorkflowResultV2;
export type ChildAssignmentAmendedResultV2 = ChildWorkflowResultV2;
export type ChildReportResultV2 = ChildWorkflowResultV2;
export type ChildDispositionResultV2 = ChildWorkflowResultV2;
export type ChildCompletionProposalResultV2 = ChildWorkflowResultV2;
export type ChildCompletionResultV2 = ChildWorkflowResultV2;
export type ChildTransferResultV2 = ChildWorkflowResultV2;
export type ClaimChildTransferResultV2 = ChildWorkflowResultV2;
export type FreshLifecycleEffect<T extends JsonValue> = PreparedLifecycleCommit<T>;

export interface ChildWorkflowClock { nowMs(): bigint }
export interface ChildWorkflowIdentitySource { uuid(): string }

export interface ChildWorkflowServiceOptions {
  readonly connection: SqliteConnection;
  readonly commandStore: LifecycleCommandStore;
  readonly authorityRepository: SessionAuthorityRepository;
  readonly capabilityService: CapabilityService;
  readonly clock: ChildWorkflowClock;
  readonly identitySource: ChildWorkflowIdentitySource;
  readonly childBindingFingerprint: (
    target: { readonly actorRole: "untrusted"; readonly clientInstanceId: string },
  ) => string | null;
  readonly faultInjector?: (point: "after-child-effects-before-ticket-cas") => void;
}

interface ChildAuthorityOperations {
  get(projectId: string, sessionId: string): SessionAuthorityRecord | null;
  insertChild(input: ChildAuthorityInsert): void;
  compareAndSwap(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly expectedState: ChildSessionState;
    readonly expectedOwnerGeneration: null;
    readonly expectedChildCapabilityGeneration: bigint | null;
    readonly expectedAuthorityCommitment: string;
    readonly next: SessionAuthorityMutation;
  }): boolean;
  latestCheckpoint(input: SessionAuthorityRecord): import("./contracts/checkpoint.js").CheckpointV1 | null;
  nextGlobalPosition(): bigint;
  loadEvents(input: SessionAuthorityRecord): readonly LifecycleEventV1[];
  requireFoldMatch(input: SessionAuthorityRecord): SessionAggregateState;
  listNonterminalChildren(projectId: string, rootSessionId: string): readonly SessionAuthorityRecord[];
  markCheckpointRequired(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly reason: string;
    readonly eventPosition: bigint;
    readonly updatedAt: string;
  }): void;
}

interface ChildTransferOperations {
  get(projectId: string, transferTicketId: string): import("../storage/lifecycle-storage.types.js").ChildTransferTicketRecord | null;
  findCreatedEventPosition(projectId: string, transferTicketId: string): bigint | null;
  insert(input: ChildTransferTicketInsert): void;
  claim(input: import("../storage/lifecycle-storage.types.js").ChildTransferClaim): unknown;
}

interface InvocationScope<C extends ChildCommand = ChildCommand> {
  readonly context: ProjectContext;
  readonly input: PreparedLifecycleWorkerCommand<C>;
  readonly command: C;
  readonly proofDigest: string;
  readonly replayExpectation: Extract<LifecycleReplayExpectation, { readonly kind: "protected" }>;
  readonly target: { readonly actorRole: "primary" | "untrusted"; readonly clientInstanceId: string };
}

interface VerifiedScope {
  readonly authorizationRecord: Extract<PersistedLifecycleAuthorizationRecord, { readonly kind: "protected" }>;
  readonly generation: string;
}

function invalid(code: "LIFECYCLE_INPUT_INVALID" | "INTEGRITY_FAILURE" = "LIFECYCLE_INPUT_INVALID"): never {
  throw new LifecycleError(code);
}

function exactNow(clock: ChildWorkflowClock): { readonly milliseconds: bigint; readonly timestamp: string } {
  const milliseconds = clock.nowMs();
  if (typeof milliseconds !== "bigint" || milliseconds < 0n || milliseconds > 253_402_300_799_999n) invalid();
  return Object.freeze({ milliseconds, timestamp: new Date(Number(milliseconds)).toISOString() });
}

function ownMethod<T extends (...arguments_: never[]) => unknown>(value: object, name: string): T {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
    || typeof descriptor.value !== "function") invalid("INTEGRITY_FAILURE");
  return descriptor.value as T;
}

function authorityOperations(transaction: LifecycleCommandTransaction): ChildAuthorityOperations {
  const value = transaction.authority as object;
  return Object.freeze({
    get: ownMethod<ChildAuthorityOperations["get"]>(value, "get"),
    insertChild: ownMethod<ChildAuthorityOperations["insertChild"]>(value, "insertChild"),
    compareAndSwap: ownMethod<ChildAuthorityOperations["compareAndSwap"]>(value, "compareAndSwap"),
    latestCheckpoint: ownMethod<ChildAuthorityOperations["latestCheckpoint"]>(value, "latestCheckpoint"),
    nextGlobalPosition: ownMethod<ChildAuthorityOperations["nextGlobalPosition"]>(value, "nextGlobalPosition"),
    loadEvents: ownMethod<ChildAuthorityOperations["loadEvents"]>(value, "loadEvents"),
    requireFoldMatch: ownMethod<ChildAuthorityOperations["requireFoldMatch"]>(value, "requireFoldMatch"),
    listNonterminalChildren: ownMethod<ChildAuthorityOperations["listNonterminalChildren"]>(
      value,
      "listNonterminalChildren",
    ),
    markCheckpointRequired: ownMethod<ChildAuthorityOperations["markCheckpointRequired"]>(value, "markCheckpointRequired"),
  });
}

function riskyTransitionChildren(
  authority: ChildAuthorityOperations,
  root: SessionAuthorityRecord,
): readonly { readonly authority: SessionAuthorityRecord; readonly aggregate: SessionAggregateState }[] {
  return Object.freeze(authority.listNonterminalChildren(root.projectId, root.sessionId).map((observed) => {
    const child = Object.freeze({ ...observed }) as SessionAuthorityRecord;
    const aggregate = authority.requireFoldMatch(child);
    if (child.sessionKind !== "child" || child.parentSessionId !== root.sessionId
      || aggregate.kind !== "child" || aggregate.parentSessionId !== root.sessionId) {
      invalid("INTEGRITY_FAILURE");
    }
    return Object.freeze({ authority: child, aggregate });
  }));
}

function transferOperations(transaction: LifecycleCommandTransaction): ChildTransferOperations {
  const value = transaction.transfers as object;
  return Object.freeze({
    get: ownMethod<ChildTransferOperations["get"]>(value, "get"),
    findCreatedEventPosition: ownMethod<ChildTransferOperations["findCreatedEventPosition"]>(value, "findCreatedEventPosition"),
    insert: ownMethod<ChildTransferOperations["insert"]>(value, "insert"),
    claim: ownMethod<ChildTransferOperations["claim"]>(value, "claim"),
  });
}

function validateContext(context: ProjectContext, command: ChildCommand): void {
  const binding = context?.binding;
  if (binding === undefined
    || (binding.actorRole !== "primary" && binding.actorRole !== "untrusted")
    || binding.projectId !== command.expectedProjectId
    || binding.vaultId !== command.expectedVaultId
    || binding.workspaceId !== command.expectedWorkspaceId
    || context.workspace !== binding.workspace
    || context.workspace.workspaceId !== binding.workspaceId
    || binding.clientNamespace.length === 0
    || binding.clientInstanceId.length === 0) throw new LifecycleError("PROJECT_BINDING_REQUIRED");
  const branchRef = context.workspace.kind === "git" ? context.workspace.branchRef : null;
  if (branchRef !== command.expectedBranchRef) throw new LifecycleError("WORKSPACE_AMBIGUOUS");
}

function proofDigest(proofFingerprint: string): string {
  const bytes = Buffer.from(proofFingerprint, "hex");
  try {
    if (bytes.length !== 32) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
    return capabilityProofDigest(bytes);
  } finally {
    bytes.fill(0);
  }
}

function authorityMutation(record: SessionAuthorityRecord): SessionAuthorityMutation {
  const {
    projectId: _projectId,
    sessionId: _sessionId,
    streamId: _streamId,
    sessionKind: _sessionKind,
    parentSessionId: _parentSessionId,
    workspaceId: _workspaceId,
    clientNamespace: _clientNamespace,
    createdAt: _createdAt,
    ...mutation
  } = record;
  return mutation;
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

function storedHandle(context: ProjectContext, authority: SessionAuthorityRecord): StoredCapabilityMaterialV1 {
  const root = authority.sessionKind === "root";
  const generation = root ? authority.ownerGeneration : authority.childCapabilityGeneration;
  const capabilityVersion = root ? authority.rootHandleCapabilityVersion : authority.childHandleCapabilityVersion;
  const keyId = root ? authority.rootHandleKeyId : authority.childHandleKeyId;
  const issueNonce = root ? authority.rootHandleIssueNonce : authority.childHandleIssueNonce;
  const issuedAt = root ? authority.rootHandleIssuedAt : authority.childHandleIssuedAt;
  const policyCode = root ? authority.rootHandlePolicyCode : authority.childHandlePolicyCode;
  const expiryKind = root ? authority.rootHandleExpiryKind : authority.childHandleExpiryKind;
  const expiresAt = root ? authority.rootHandleExpiresAt : authority.childHandleExpiresAt;
  const actorRole = root ? authority.rootHandleActorRole : authority.childHandleActorRole;
  const clientInstanceId = root ? authority.rootHandleClientInstanceId : authority.childHandleClientInstanceId;
  const verifier = root ? authority.rootHandleVerifier : authority.childHandleVerifier;
  if (generation === null || capabilityVersion !== 1 || keyId === null || issueNonce === null
    || issuedAt === null || policyCode === null || expiryKind === null || actorRole === null
    || clientInstanceId === null || verifier === null) invalid("INTEGRITY_FAILURE");
  return Object.freeze({
    claims: {
      capabilityVersion: 1 as const,
      keyId,
      projectId: authority.projectId,
      vaultId: context.binding.vaultId,
      storeId: context.binding.storeId,
      workspaceId: authority.workspaceId,
      clientNamespace: authority.clientNamespace,
      sessionId: authority.sessionId,
      kind: root ? "root-session-handle" as const : "child-session-handle" as const,
      capabilityGeneration: generation.toString(),
      issuedAt,
      policyCode,
      expiryKind,
      expiresAt,
      issueNonce,
      actorRole,
      clientInstanceId,
    },
    verifier,
  });
}

function pendingEvent(
  eventType: string,
  sessionId: string,
  parentSessionId: string,
  occurredAt: string,
  payload: JsonValue,
  causationId?: string,
): PendingEvent {
  return {
    eventType,
    eventSchemaVersion: 1,
    occurredAt,
    visibilityScope: "session",
    sessionId,
    parentSessionId,
    ...(causationId === undefined ? {} : { causationId }),
    confidence: "high",
    verificationStatus: "verified",
    payload,
    sourceRefs: [],
    evidenceRefs: [],
    evidenceDigests: [],
  };
}

function latestEventId(events: readonly LifecycleEventV1[]): string {
  const event = events.at(-1);
  if (event === undefined) invalid("INTEGRITY_FAILURE");
  return event.eventId;
}

function noAuthorityMaterial(): WorkerAuthorityMaterialResultV1 {
  return Object.freeze({
    status: "not-issued",
    target: null,
    authorityCommitment: null,
    capabilityGeneration: null,
    descriptor: null,
    recoveryCode: null,
  });
}

function staleAuthorityMaterial(): WorkerAuthorityMaterialResultV1 {
  return Object.freeze({
    status: "stale",
    target: null,
    authorityCommitment: null,
    capabilityGeneration: null,
    descriptor: null,
    recoveryCode: "SESSION_HANDLE_STALE",
  });
}

function childRecord(input: {
  readonly context: ProjectContext;
  readonly parent: SessionAuthorityRecord;
  readonly childSessionId: string;
  readonly eventPosition: bigint;
  readonly now: string;
  readonly material: StoredCapabilityMaterialV1 | null;
}): ChildAuthorityInsert {
  const material = input.material;
  const provisional: ChildAuthorityInsert = {
    projectId: input.parent.projectId,
    sessionId: input.childSessionId,
    streamId: `session/${input.childSessionId}`,
    sessionKind: "child",
    parentSessionId: input.parent.sessionId,
    workspaceId: input.parent.workspaceId,
    clientNamespace: input.parent.clientNamespace,
    semanticState: "active",
    ownerGeneration: null,
    childCapabilityGeneration: material === null ? null : 1n,
    directAccessEnabled: material !== null,
    continuityFingerprintAlgorithm: null,
    continuityFingerprintSchemaVersion: null,
    continuityFingerprintKeyId: null,
    continuityFingerprintDomain: null,
    continuityFingerprint: null,
    rootHandleCapabilityVersion: null,
    rootHandleKeyId: null,
    rootHandleIssueNonce: null,
    rootHandleIssuedAt: null,
    rootHandlePolicyCode: null,
    rootHandleExpiryKind: null,
    rootHandleExpiresAt: null,
    rootHandleActorRole: null,
    rootHandleClientInstanceId: null,
    rootHandleVerifier: null,
    rootHandleIssuanceId: null,
    resumeTokenCapabilityVersion: null,
    resumeTokenKeyId: null,
    resumeTokenIssueNonce: null,
    resumeTokenIssuedAt: null,
    resumeTokenPolicyCode: null,
    resumeTokenExpiryKind: null,
    resumeTokenExpiresAt: null,
    resumeTokenActorRole: null,
    resumeTokenVerifier: null,
    resumeTokenIssuanceId: null,
    childHandleCapabilityVersion: material?.claims.capabilityVersion ?? null,
    childHandleKeyId: material?.claims.keyId ?? null,
    childHandleIssueNonce: material?.claims.issueNonce ?? null,
    childHandleIssuedAt: material?.claims.issuedAt ?? null,
    childHandlePolicyCode: material?.claims.policyCode ?? null,
    childHandleExpiryKind: material?.claims.expiryKind ?? null,
    childHandleExpiresAt: material?.claims.expiresAt ?? null,
    childHandleActorRole: material === null ? null : "untrusted",
    childHandleClientInstanceId: material?.claims.clientInstanceId ?? null,
    childHandleVerifier: material?.verifier ?? null,
    childHandleIssuanceId: material === null ? null : input.childSessionId,
    authorityCommitment: "0".repeat(64),
    authorityEventPosition: input.eventPosition,
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
    createdAt: input.now,
    updatedAt: input.now,
  };
  return Object.freeze({
    ...provisional,
    authorityCommitment: authorityCommitment(committedAuthority(provisional)),
  });
}

export class ChildWorkflowService {
  readonly #connection: SqliteConnection;
  readonly #store: LifecycleCommandStore;
  readonly #authority: SessionAuthorityRepository;
  readonly #capabilities: CapabilityService;
  readonly #clock: ChildWorkflowClock;
  readonly #ids: ChildWorkflowIdentitySource;
  readonly #bindingFingerprint: ChildWorkflowServiceOptions["childBindingFingerprint"];
  readonly #faultInjector: ChildWorkflowServiceOptions["faultInjector"];
  readonly #scopes = new WeakMap<LifecycleCommandTransaction, InvocationScope>();

  constructor(options: ChildWorkflowServiceOptions) {
    if (options === undefined || typeof options.childBindingFingerprint !== "function") invalid();
    this.#connection = options.connection;
    this.#store = options.commandStore;
    this.#authority = options.authorityRepository;
    this.#capabilities = options.capabilityService;
    this.#clock = options.clock;
    this.#ids = options.identitySource;
    this.#bindingFingerprint = options.childBindingFingerprint;
    this.#faultInjector = options.faultInjector;
  }

  execute(
    context: ProjectContext,
    input: PreparedLifecycleWorkerCommand<Exclude<LifecycleSemanticCommandDraft, { commandType: "root-start" }>>,
  ): WorkerLifecycleResult<ChildWorkflowResultV2> {
    const decoded = decodeLifecycleSemanticCommandDraft(input.command);
    if (!new Set([
      "fork-child", "amend-child-assignment", "record-child-report", "disposition-child-report",
      "propose-child-completion", "complete-child-session", "suspend-child-session", "claim-child-transfer",
    ]).has(decoded.commandType)) invalid();
    const command = decoded as ChildCommand;
    assertSemanticCommandAuthorization(command, input.authorization);
    validateContext(context, command);
    if (input.authorization.kind !== "protected" || input.authorization.proof === null
      || input.authorization.approval !== null) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
    const target = command.commandType === "fork-child" && input.authorization.childBindingGrant !== null
      ? Object.freeze({
          actorRole: "untrusted" as const,
          clientInstanceId: input.authorization.childBindingGrant.targetClientInstanceId,
        })
      : Object.freeze({
          actorRole: context.binding.actorRole as "primary" | "untrusted",
          clientInstanceId: context.binding.clientInstanceId,
        });
    const digest = proofDigest(input.authorization.proof.proofFingerprint);
    const replayExpectation: Extract<LifecycleReplayExpectation, { kind: "protected" }> = Object.freeze({
      kind: "protected",
      proof: Object.freeze({ version: 1, nonce: input.authorization.proof.proofNonce, digest }),
      approval: null,
      authorizationSessionId: input.authorization.authoritySessionId,
      targetSessionId: input.authorization.targetSessionId,
      presenting: Object.freeze({
        actorRole: context.binding.actorRole,
        clientInstanceId: context.binding.clientInstanceId,
      }),
      target,
    });
    const scope: InvocationScope = { context, input: input as PreparedLifecycleWorkerCommand<ChildCommand>, command, proofDigest: digest, replayExpectation, target };
    const capabilityKind = context.binding.actorRole === "untrusted"
      ? "child-session-handle" as const
      : "root-session-handle" as const;
    const execution = this.#store.execute<ChildWorkflowResultV2>({
      context,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      commandType: command.commandType,
      candidateIntentHash: input.candidateIntentHash,
      authoritativeIntentHash: input.candidateIntentHash,
      semanticCommand: command,
      capabilityKind,
      capabilityGeneration: null,
      capabilityGenerationResolution: "fresh-commit",
      replayExpectation,
    }, (transaction) => {
      this.#scopes.set(transaction, scope);
      try {
        switch (command.commandType) {
          case "fork-child": return this.fork(transaction, command);
          case "amend-child-assignment": return this.amendAssignment(transaction, command);
          case "record-child-report": return this.recordReport(transaction, command);
          case "disposition-child-report": return this.dispositionReport(transaction, command);
          case "propose-child-completion": return this.proposeCompletion(transaction, command);
          case "complete-child-session": return this.complete(transaction, command);
          case "suspend-child-session": return this.suspendAndTransfer(transaction, command);
          case "claim-child-transfer": return this.claimTransfer(transaction, command);
        }
      } finally {
        this.#scopes.delete(transaction);
      }
    });
    let material = noAuthorityMaterial();
    if (execution.authorizationRecord.target.actorRole === "untrusted"
      && execution.publicResult.operation === "fork-child") {
      if (execution.publicResult.directAccessEnabled) material = staleAuthorityMaterial();
      let readTransactionBegan = false;
      try {
        this.#connection.exec("BEGIN DEFERRED");
        readTransactionBegan = true;
        const authority = this.#authority.get(this.#connection, context.binding.projectId, execution.publicResult.childSessionId);
        if (authority === null || authority.sessionKind !== "child") invalid("INTEGRITY_FAILURE");
        const parent = this.#authority.get(this.#connection, context.binding.projectId, execution.publicResult.parentSessionId);
        if (parent === null || parent.sessionKind !== "root") invalid("INTEGRITY_FAILURE");
        const childAggregate = this.#authority.requireFoldMatch(this.#connection, authority);
        const parentAggregate = this.#authority.requireFoldMatch(this.#connection, parent);
        if (childAggregate.kind !== "child" || parentAggregate.kind !== "root"
          || authority.parentSessionId !== parent.sessionId) invalid("INTEGRITY_FAILURE");
        if (authority.directAccessEnabled && authority.childCapabilityGeneration !== null
          && authority.revocationEventPosition === null && authority.revokedAt === null
          && authority.terminalEventPosition === null && authority.terminalAt === null
          && parent.semanticState === "active" && parent.ownerGeneration !== null
          && BigInt(childAggregate.rootOwnerGeneration) === parent.ownerGeneration
          && parent.revocationEventPosition === null && parent.revokedAt === null
          && parent.terminalEventPosition === null && parent.terminalAt === null) {
          const resolved = this.#capabilities.authorityMaterial({
            authorityCommitment: authority.authorityCommitment,
            expectedCapabilityGeneration: "1",
            currentCapabilityGeneration: authority.childCapabilityGeneration.toString(),
            target: {
              actorRole: execution.authorizationRecord.target.actorRole as "primary" | "untrusted",
              clientInstanceId: execution.authorizationRecord.target.clientInstanceId,
            },
            materials: [storedHandle(context, authority)],
          });
          if (resolved.status === "current" && resolved.descriptor !== undefined) {
            material = Object.freeze({
              status: "current",
              target: resolved.descriptor.target,
              authorityCommitment: resolved.descriptor.authorityCommitment,
              capabilityGeneration: resolved.descriptor.capabilityGeneration,
              descriptor: resolved.descriptor,
              recoveryCode: null,
            });
          } else {
            material = Object.freeze({
              status: resolved.status,
              target: null,
              authorityCommitment: null,
              capabilityGeneration: null,
              descriptor: null,
              recoveryCode: resolved.recoveryCode ?? null,
            });
          }
        }
        this.#connection.exec("COMMIT");
        readTransactionBegan = false;
      } catch (error) {
        if (readTransactionBegan) {
          try { this.#connection.exec("ROLLBACK"); } catch { invalid("INTEGRITY_FAILURE"); }
        }
        throw error;
      }
    }
    return Object.freeze({ kind: "success", publicResult: execution.publicResult, authorityMaterial: material });
  }

  #scope<C extends ChildCommand>(transaction: LifecycleCommandTransaction, command: C): InvocationScope<C> {
    const scope = this.#scopes.get(transaction);
    if (scope === undefined || scope.command !== command) invalid("INTEGRITY_FAILURE");
    return scope as InvocationScope<C>;
  }

  #requireCurrentRoot(
    authority: ChildAuthorityOperations,
    projectId: string,
    rootSessionId: string,
  ): {
    readonly record: SessionAuthorityRecord;
    readonly aggregate: Extract<SessionAggregateState, { readonly kind: "root" }>;
  } {
    const observed = authority.get(projectId, rootSessionId);
    if (observed === null) throw new LifecycleError("SESSION_NOT_FOUND");
    const record = Object.freeze({ ...observed }) as SessionAuthorityRecord;
    if (record.sessionKind !== "root" || record.parentSessionId !== null || record.ownerGeneration === null) {
      throw new LifecycleError("SESSION_STATE_CONFLICT");
    }
    if (record.semanticState !== "active" || record.revocationEventPosition !== null
      || record.revokedAt !== null || record.terminalEventPosition !== null || record.terminalAt !== null) {
      throw new LifecycleError("SESSION_HANDLE_STALE");
    }
    const aggregate = authority.requireFoldMatch(record);
    if (aggregate.kind !== "root" || aggregate.state !== "active") {
      throw new LifecycleError("SESSION_STATE_CONFLICT");
    }
    return Object.freeze({ record, aggregate });
  }

  #verify(
    transaction: LifecycleCommandTransaction,
    command: ChildCommand,
    authority: SessionAuthorityRecord,
  ): VerifiedScope {
    const scope = this.#scope(transaction, command);
    const authorization = scope.input.authorization;
    if (authorization.kind !== "protected" || authorization.proof === null) {
      throw new LifecycleError("SESSION_CAPABILITY_INVALID");
    }
    if (authority.revocationEventPosition !== null || authority.revokedAt !== null
      || authority.terminalEventPosition !== null || authority.terminalAt !== null
      || (authority.sessionKind === "root" && authority.semanticState !== "active")
      || (authority.sessionKind === "child" && !authority.directAccessEnabled)) {
      throw new LifecycleError("SESSION_HANDLE_STALE");
    }
    const generation = authority.sessionKind === "root"
      ? authority.ownerGeneration?.toString()
      : authority.childCapabilityGeneration?.toString();
    if (generation === undefined || generation === null) throw new LifecycleError("SESSION_HANDLE_STALE");
    if (authority.sessionId !== authorization.authoritySessionId
      || authority.projectId !== scope.context.binding.projectId
      || authority.workspaceId !== scope.context.binding.workspaceId
      || authority.clientNamespace !== scope.context.binding.clientNamespace
      || (authority.sessionKind === "root" && (
        scope.context.binding.actorRole !== "primary"
        || authority.rootHandleClientInstanceId !== scope.context.binding.clientInstanceId
      ))
      || (authority.sessionKind === "child" && (
        scope.context.binding.actorRole !== "untrusted"
        || authority.childHandleClientInstanceId !== scope.context.binding.clientInstanceId
      ))) throw new LifecycleError("SESSION_OWNERSHIP_MISMATCH");
    const capabilityKind: "root-session-handle" | "child-session-handle" = authority.sessionKind === "root"
      ? "root-session-handle"
      : "child-session-handle";
    const assertions = {
      authorizationKind: "protected" as const,
      authorizationSessionId: authorization.authoritySessionId,
      targetSessionId: authorization.targetSessionId,
      projectId: scope.context.binding.projectId,
      vaultId: scope.context.binding.vaultId,
      storeId: scope.context.binding.storeId,
      workspaceId: scope.context.binding.workspaceId,
      clientNamespace: scope.context.binding.clientNamespace,
      capabilityKind,
      capabilityGeneration: generation,
      presentingActorRole: scope.context.binding.actorRole,
      presentingClientInstanceId: scope.context.binding.clientInstanceId,
      targetActorRole: scope.target.actorRole,
      targetClientInstanceId: scope.target.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
    };
    const authoritative = buildLifecycleIntentWitness(command, assertions);
    if (!LOWER_HASH.test(scope.input.candidateIntentHash)
      || authoritative.intentHash !== scope.input.candidateIntentHash) throw new LifecycleError("IDEMPOTENCY_CONFLICT");
    const proofTarget: SemanticCommandProofTargetV1 = {
      proofVersion: 1,
      target: "semantic-command",
      projectId: scope.context.binding.projectId,
      vaultId: scope.context.binding.vaultId,
      storeId: scope.context.binding.storeId,
      workspaceId: scope.context.binding.workspaceId,
      clientNamespace: scope.context.binding.clientNamespace,
      authoritySessionId: authorization.authoritySessionId,
      targetSessionId: authorization.targetSessionId,
      presentingActorRole: scope.context.binding.actorRole,
      presentingClientInstanceId: scope.context.binding.clientInstanceId,
      targetActorRole: scope.target.actorRole,
      targetClientInstanceId: scope.target.clientInstanceId,
      capabilityKind,
      capabilityGeneration: generation,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: authoritative.intentHash,
      proofNonce: authorization.proof.proofNonce,
    };
    const verified = this.#capabilities.verifyProof(storedHandle(scope.context, authority), proofTarget, authorization.proof);
    if (verified.digest !== scope.proofDigest) invalid("INTEGRITY_FAILURE");
    return Object.freeze({
      generation,
      authorizationRecord: Object.freeze({ ...scope.replayExpectation, proof: Object.freeze(verified) }),
    });
  }

  fork(
    transaction: LifecycleCommandTransaction,
    command: ForkChildCommandV2,
  ): FreshLifecycleEffect<ForkChildResultV2> {
    const scope = this.#scope(transaction, command);
    const authority = authorityOperations(transaction);
    const { record: parent, aggregate } = this.#requireCurrentRoot(
      authority,
      scope.context.binding.projectId,
      command.parentSessionId,
    );
    if (BigInt(command.expectedStreamVersion) !== aggregate.streamVersion) throw new LifecycleError("EVENT_CONFLICT");
    const rootOwnerGeneration = parent.ownerGeneration;
    if (rootOwnerGeneration === null) invalid("INTEGRITY_FAILURE");
    const causationId = latestEventId(authority.loadEvents(parent));
    const verified = this.#verify(transaction, command, parent);
    let targetClientInstanceId: string | null = null;
    if (command.directAccessRequested) {
      const grant = scope.input.authorization.kind === "protected"
        ? scope.input.authorization.childBindingGrant
        : null;
      if (grant === null || !Object.hasOwn(grant, "mac")) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
      const signed = grant as ChildBindingGrantV1;
      const bindingFingerprint = this.#bindingFingerprint({
        actorRole: "untrusted",
        clientInstanceId: signed.targetClientInstanceId,
      });
      if (bindingFingerprint === null) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
      this.#capabilities.verifyChildBindingGrant(signed, {
        projectId: scope.context.binding.projectId,
        storeId: scope.context.binding.storeId,
        parentSessionId: command.parentSessionId,
        targetClientInstanceId: signed.targetClientInstanceId,
        bindingFingerprint,
      });
      targetClientInstanceId = signed.targetClientInstanceId;
    } else if (scope.input.authorization.kind !== "protected"
      || scope.input.authorization.childBindingGrant !== null) throw new LifecycleError("SESSION_CAPABILITY_INVALID");
    const childSessionId = this.#ids.uuid();
    const targetMaterial = targetClientInstanceId === null
      ? null
      : this.#capabilities.prepareCapability({
        projectId: scope.context.binding.projectId,
        vaultId: scope.context.binding.vaultId,
        storeId: scope.context.binding.storeId,
        workspaceId: scope.context.binding.workspaceId,
        clientNamespace: scope.context.binding.clientNamespace,
        sessionId: childSessionId,
        kind: "child-session-handle",
        capabilityGeneration: "1",
        policyCode: "child-default-v1",
        expiryKind: "until-revoked",
        expiresAt: null,
        actorRole: "untrusted",
        clientInstanceId: targetClientInstanceId,
      });
    const now = exactNow(this.#clock);
    const eventPosition = authority.nextGlobalPosition();
    const child = childRecord({ context: scope.context, parent, childSessionId, eventPosition, now: now.timestamp, material: targetMaterial });
    const result: ForkChildResultV2 = Object.freeze({
      resultVersion: 2,
      operation: "fork-child",
      childSessionId,
      parentSessionId: parent.sessionId,
      directAccessEnabled: command.directAccessRequested,
      rootOwnerGeneration: rootOwnerGeneration.toString(),
      assignment: Object.freeze({ ...command.assignment }),
      assignmentRevision: "1",
      state: "active",
      eventPosition: eventPosition.toString(),
      finalStreamVersion: "1",
    });
    return {
      append: {
        context: scope.context,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.commandType,
        correlationId: aggregate.correlationId,
        agentId: command.agentId,
        expectedStreamVersion: 0n,
        streamId: child.streamId,
        streamType: "session",
        events: [pendingEvent("SessionForked", childSessionId, parent.sessionId, now.timestamp, {
          parentSessionId: parent.sessionId,
          assignment: { ...command.assignment },
          rootOwnerGeneration: Number(rootOwnerGeneration),
          directAccessEnabled: command.directAccessRequested,
          authorityCommitment: child.authorityCommitment,
          sourceTransferTicketId: null,
        }, causationId)],
        outbox: [],
        publicResponse: result,
      },
      authorizationRecord: verified.authorizationRecord,
      freshCapabilityGeneration: verified.generation,
      afterAppend: (committed, currentTransaction) => {
        if (committed.events.length !== 1 || committed.events[0]?.globalPosition !== eventPosition) invalid("INTEGRITY_FAILURE");
        authorityOperations(currentTransaction).insertChild(child);
      },
    };
  }

  amendAssignment(
    transaction: LifecycleCommandTransaction,
    command: AmendChildAssignmentCommandV2,
  ): FreshLifecycleEffect<ChildAssignmentAmendedResultV2> {
    const scope = this.#scope(transaction, command);
    if (scope.context.binding.actorRole !== "primary") throw new LifecycleError("SESSION_OWNERSHIP_MISMATCH");
    const authority = authorityOperations(transaction);
    const { record: parent } = this.#requireCurrentRoot(
      authority,
      scope.context.binding.projectId,
      command.parentSessionId,
    );
    const observed = authority.get(scope.context.binding.projectId, command.childSessionId);
    if (observed === null) throw new LifecycleError("SESSION_NOT_FOUND");
    const child = Object.freeze({ ...observed }) as SessionAuthorityRecord;
    if (child.sessionKind !== "child"
      || child.parentSessionId !== command.parentSessionId || child.terminalEventPosition !== null) {
      throw new LifecycleError("SESSION_STATE_CONFLICT");
    }
    const aggregate = authority.requireFoldMatch(child);
    if (aggregate.kind !== "child" || aggregate.state === "completed" || aggregate.state === "transferred") {
      throw new LifecycleError("SESSION_STATE_CONFLICT");
    }
    if (BigInt(command.expectedStreamVersion) !== aggregate.streamVersion
      || BigInt(command.expectedAssignmentRevision) !== BigInt(aggregate.assignmentRevision)) {
      throw new LifecycleError("EVENT_CONFLICT");
    }
    if (command.assignment.assignmentId !== aggregate.assignment.assignmentId
      || (command.assignment.summary === aggregate.assignment.summary && command.assignment.scope === aggregate.assignment.scope)) {
      throw new LifecycleError("LIFECYCLE_INPUT_INVALID");
    }
    const causationId = latestEventId(authority.loadEvents(child));
    const verified = this.#verify(transaction, command, Object.freeze({ ...parent }) as SessionAuthorityRecord);
    const now = exactNow(this.#clock);
    const eventPosition = authority.nextGlobalPosition();
    const nextRevision = aggregate.assignmentRevision + 1;
    const result: ChildAssignmentAmendedResultV2 = Object.freeze({
      resultVersion: 2,
      operation: "amend-child-assignment",
      childSessionId: child.sessionId,
      parentSessionId: command.parentSessionId,
      assignment: Object.freeze({ ...command.assignment }),
      assignmentRevision: nextRevision.toString(),
      state: aggregate.state,
      eventPosition: eventPosition.toString(),
      finalStreamVersion: (aggregate.streamVersion + 1n).toString(),
    });
    return {
      append: {
        context: scope.context,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.commandType,
        correlationId: aggregate.correlationId,
        agentId: command.agentId,
        expectedStreamVersion: aggregate.streamVersion,
        streamId: child.streamId,
        streamType: "session",
        events: [pendingEvent("ChildAssignmentAmended", child.sessionId, command.parentSessionId, now.timestamp, {
          previousAssignmentRevision: aggregate.assignmentRevision,
          assignmentRevision: nextRevision,
          assignment: { ...command.assignment },
          reasonCode: command.reasonCode,
        }, causationId)],
        outbox: [],
        publicResponse: result,
      },
      authorizationRecord: verified.authorizationRecord,
      freshCapabilityGeneration: verified.generation,
      afterAppend: (committed) => {
        if (committed.events.length !== 1 || committed.events[0]?.globalPosition !== eventPosition) invalid("INTEGRITY_FAILURE");
      },
    };
  }

  // Remaining child operations are implemented below as one atomic semantic transaction each.
  recordReport(transaction: LifecycleCommandTransaction, command: RecordChildReportCommandV2): FreshLifecycleEffect<ChildReportResultV2> { return this.#recordReport(transaction, command); }
  dispositionReport(transaction: LifecycleCommandTransaction, command: DispositionChildReportCommandV2): FreshLifecycleEffect<ChildDispositionResultV2> { return this.#dispositionReport(transaction, command); }
  proposeCompletion(transaction: LifecycleCommandTransaction, command: ProposeChildCompletionCommandV2): FreshLifecycleEffect<ChildCompletionProposalResultV2> { return this.#proposeCompletion(transaction, command); }
  complete(transaction: LifecycleCommandTransaction, command: CompleteChildSessionCommandV2): FreshLifecycleEffect<ChildCompletionResultV2> { return this.#complete(transaction, command); }
  suspendAndTransfer(transaction: LifecycleCommandTransaction, command: SuspendChildSessionCommandV2): FreshLifecycleEffect<ChildTransferResultV2> { return this.#suspendAndTransfer(transaction, command); }
  claimTransfer(transaction: LifecycleCommandTransaction, command: ClaimChildTransferCommandV2): FreshLifecycleEffect<ClaimChildTransferResultV2> { return this.#claimTransfer(transaction, command); }

  #recordReport(
    transaction: LifecycleCommandTransaction,
    command: RecordChildReportCommandV2,
  ): FreshLifecycleEffect<ChildReportResultV2> {
    const scope = this.#scope(transaction, command);
    const authority = authorityOperations(transaction);
    const direct = scope.input.authorization.kind === "protected"
      && scope.input.authorization.authoritySessionId === command.childSessionId;
    let parent: SessionAuthorityRecord;
    if (direct) {
      const parentObserved = authority.get(scope.context.binding.projectId, command.parentSessionId);
      if (parentObserved === null) throw new LifecycleError("SESSION_NOT_FOUND");
      parent = Object.freeze({ ...parentObserved }) as SessionAuthorityRecord;
      if (parent.sessionKind !== "root" || parent.parentSessionId !== null) {
        throw new LifecycleError("SESSION_STATE_CONFLICT");
      }
      const parentAggregate = authority.requireFoldMatch(parent);
      if (parentAggregate.kind !== "root") throw new LifecycleError("SESSION_STATE_CONFLICT");
    } else {
      parent = this.#requireCurrentRoot(
        authority,
        scope.context.binding.projectId,
        command.parentSessionId,
      ).record;
    }
    const childObserved = authority.get(scope.context.binding.projectId, command.childSessionId);
    if (childObserved === null) throw new LifecycleError("SESSION_NOT_FOUND");
    const child = Object.freeze({ ...childObserved }) as SessionAuthorityRecord;
    if (child.sessionKind !== "child"
      || child.parentSessionId !== parent.sessionId || child.terminalEventPosition !== null) {
      throw new LifecycleError("SESSION_STATE_CONFLICT");
    }
    const aggregate = authority.requireFoldMatch(child);
    if (aggregate.kind !== "child"
      || (aggregate.state !== "active" && aggregate.state !== "completion-proposed" && aggregate.state !== "suspended")) {
      throw new LifecycleError("SESSION_STATE_CONFLICT");
    }
    if (BigInt(command.expectedStreamVersion) !== aggregate.streamVersion) throw new LifecycleError("EVENT_CONFLICT");
    if (direct && (scope.context.binding.actorRole !== "untrusted" || command.childAuthorAgentId !== command.agentId)) {
      throw new LifecycleError("SESSION_OWNERSHIP_MISMATCH");
    }
    if (!direct && (scope.context.binding.actorRole !== "primary"
      || scope.input.authorization.kind !== "protected"
      || scope.input.authorization.authoritySessionId !== parent.sessionId)) {
      throw new LifecycleError("SESSION_OWNERSHIP_MISMATCH");
    }
    const verified = this.#verify(transaction, command, direct ? child : parent);
    const now = exactNow(this.#clock);
    const reportId = this.#ids.uuid() as ReportId;
    const allReportItemIds: ReportItemId[] = [];
    const materialize = (items: readonly ChildReportItemDraftV1[]): readonly ChildReportItemV1[] => Object.freeze(
      items.map((item) => {
        const itemId = this.#ids.uuid() as ReportItemId;
        allReportItemIds.push(itemId);
        return Object.freeze({ itemId, ...item });
      }),
    );
    const draft: ChildReportDraftV1 = command.report;
    const materialized: Record<(typeof REPORT_FIELDS)[number], readonly ChildReportItemV1[]> = {
      findings: materialize(draft.findings),
      proposedDecisions: materialize(draft.proposedDecisions),
      filesObservedOrChanged: materialize(draft.filesObservedOrChanged),
      verificationPerformed: materialize(draft.verificationPerformed),
      openFollowUps: materialize(draft.openFollowUps),
      blockers: materialize(draft.blockers),
    };
    const report = decodeChildReportV1({
      reportVersion: 1,
      reportId,
      childSessionId: child.sessionId,
      parentSessionId: parent.sessionId,
      assignmentId: aggregate.assignment.assignmentId,
      createdAt: now.timestamp,
      outcomeSummary: draft.outcomeSummary,
      ...materialized,
      evidenceFingerprints: draft.evidenceFingerprints,
    });
    const { allReportItemIds: _derivedReportItemIds, ...persistedReport } = report;
    const priorEvents = authority.loadEvents(child);
    if (priorEvents.some((event) => event.eventType === "ChildWorkReported"
      && event.payload.report.reportId === report.reportId)) throw new LifecycleError("EVENT_CONFLICT");
    const eventPosition = authority.nextGlobalPosition();
    const result: ChildReportResultV2 = Object.freeze({
      resultVersion: 2,
      operation: "record-child-report",
      childSessionId: child.sessionId,
      parentSessionId: parent.sessionId,
      assignmentRevision: aggregate.assignmentRevision.toString(),
      reportId: report.reportId,
      reportItemIds: [...report.allReportItemIds],
      state: aggregate.state,
      eventPosition: eventPosition.toString(),
      finalStreamVersion: (aggregate.streamVersion + 1n).toString(),
    });
    return {
      append: {
        context: scope.context,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.commandType,
        correlationId: aggregate.correlationId,
        agentId: command.agentId,
        expectedStreamVersion: aggregate.streamVersion,
        streamId: child.streamId,
        streamType: "session",
        events: [pendingEvent("ChildWorkReported", child.sessionId, parent.sessionId, now.timestamp, {
          report: persistedReport as unknown as JsonValue,
          childAuthorAgentId: command.childAuthorAgentId,
          primaryRecorderAgentId: direct ? null : command.agentId,
        }, latestEventId(priorEvents))],
        outbox: [],
        publicResponse: result,
      },
      authorizationRecord: verified.authorizationRecord,
      freshCapabilityGeneration: verified.generation,
      afterAppend: (committed) => {
        if (committed.events.length !== 1 || committed.events[0]?.globalPosition !== eventPosition) invalid("INTEGRITY_FAILURE");
      },
    };
  }

  #dispositionReport(
    transaction: LifecycleCommandTransaction,
    command: DispositionChildReportCommandV2,
  ): FreshLifecycleEffect<ChildDispositionResultV2> {
    const scope = this.#scope(transaction, command);
    if (scope.context.binding.actorRole !== "primary") throw new LifecycleError("SESSION_OWNERSHIP_MISMATCH");
    const authority = authorityOperations(transaction);
    const { record: parent } = this.#requireCurrentRoot(
      authority,
      scope.context.binding.projectId,
      command.parentSessionId,
    );
    const childObserved = authority.get(scope.context.binding.projectId, command.childSessionId);
    if (childObserved === null) throw new LifecycleError("SESSION_NOT_FOUND");
    const child = Object.freeze({ ...childObserved }) as SessionAuthorityRecord;
    if (child.sessionKind !== "child"
      || child.parentSessionId !== parent.sessionId || child.terminalEventPosition !== null) {
      throw new LifecycleError("SESSION_STATE_CONFLICT");
    }
    const aggregate = authority.requireFoldMatch(child);
    if (aggregate.kind !== "child" || (aggregate.state !== "active" && aggregate.state !== "completion-proposed")) {
      throw new LifecycleError("SESSION_STATE_CONFLICT");
    }
    if (BigInt(command.expectedStreamVersion) !== aggregate.streamVersion) throw new LifecycleError("EVENT_CONFLICT");
    const events = authority.loadEvents(child);
    const report = events.find((event): event is Extract<LifecycleEventV1, { eventType: "ChildWorkReported" }> =>
      event.eventType === "ChildWorkReported" && event.payload.report.reportId === command.disposition.reportId);
    if (report === undefined) throw new LifecycleError("CHILD_DISPOSITION_INVALID");
    if (report.payload.report.allReportItemIds.length !== command.disposition.allReportItemIds.length
      || report.payload.report.allReportItemIds.some((item) => !command.disposition.allReportItemIds.includes(item))) {
      throw new LifecycleError("CHILD_DISPOSITION_INVALID");
    }
    const priorDispositions = events.filter((event): event is Extract<LifecycleEventV1, { eventType: "ChildWorkDispositioned" }> =>
      event.eventType === "ChildWorkDispositioned"
      && event.payload.disposition.reportId === command.disposition.reportId);
    const latestDisposition = priorDispositions.at(-1);
    if (command.disposition.kind === "superseded") {
      const targetReport = events.find((event): event is Extract<LifecycleEventV1, { eventType: "ChildWorkReported" }> =>
        event.eventType === "ChildWorkReported"
        && event.payload.report.reportId === command.disposition.supersededByReportId);
      if (latestDisposition === undefined
        || latestDisposition.payload.disposition.kind === "superseded"
        || targetReport === undefined
        || BigInt(targetReport.globalPosition) <= BigInt(latestDisposition.globalPosition)) {
        throw new LifecycleError("CHILD_DISPOSITION_INVALID");
      }
    } else if (latestDisposition !== undefined) {
      throw new LifecycleError("CHILD_DISPOSITION_INVALID");
    }
    const verified = this.#verify(transaction, command, parent);
    const now = exactNow(this.#clock);
    const eventPosition = authority.nextGlobalPosition();
    const completionDispositionRequestsMoreWork = aggregate.state === "completion-proposed"
      && command.disposition.kind !== "accepted"
      && aggregate.completionReportId === command.disposition.reportId;
    const nextState = completionDispositionRequestsMoreWork ? "active" as const : aggregate.state;
    const result: ChildDispositionResultV2 = Object.freeze({
      resultVersion: 2,
      operation: "disposition-child-report",
      childSessionId: child.sessionId,
      parentSessionId: parent.sessionId,
      disposition: Object.freeze({ kind: command.disposition.kind, reportId: command.disposition.reportId }),
      state: nextState,
      eventPosition: eventPosition.toString(),
      finalStreamVersion: (aggregate.streamVersion + 1n).toString(),
    });
    return {
      append: {
        context: scope.context,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.commandType,
        correlationId: aggregate.correlationId,
        agentId: command.agentId,
        expectedStreamVersion: aggregate.streamVersion,
        streamId: child.streamId,
        streamType: "session",
        events: [pendingEvent("ChildWorkDispositioned", child.sessionId, parent.sessionId, now.timestamp, {
          disposition: command.disposition as unknown as JsonValue,
        }, latestEventId(events))],
        outbox: [],
        publicResponse: result,
      },
      authorizationRecord: verified.authorizationRecord,
      freshCapabilityGeneration: verified.generation,
      beforeAppend: completionDispositionRequestsMoreWork ? (_planned, currentTransaction) => {
        const next: SessionAuthorityRecord = { ...child, semanticState: "active", updatedAt: now.timestamp };
        if (!authorityOperations(currentTransaction).compareAndSwap({
          projectId: child.projectId,
          sessionId: child.sessionId,
          expectedState: child.semanticState as ChildSessionState,
          expectedOwnerGeneration: null,
          expectedChildCapabilityGeneration: child.childCapabilityGeneration,
          expectedAuthorityCommitment: child.authorityCommitment,
          next: authorityMutation(next),
        })) throw new LifecycleError("EVENT_CONFLICT");
      } : undefined,
      afterAppend: (committed, currentTransaction) => {
        if (committed.events.length !== 1 || committed.events[0]?.globalPosition !== eventPosition) invalid("INTEGRITY_FAILURE");
        if (command.disposition.kind === "accepted" || command.disposition.kind === "partially-accepted") {
          authorityOperations(currentTransaction).markCheckpointRequired({
            projectId: parent.projectId,
            sessionId: parent.sessionId,
            reason: "accepted-child-report",
            eventPosition,
            updatedAt: now.timestamp,
          });
        }
      },
    };
  }

  #proposeCompletion(
    transaction: LifecycleCommandTransaction,
    command: ProposeChildCompletionCommandV2,
  ): FreshLifecycleEffect<ChildCompletionProposalResultV2> {
    const scope = this.#scope(transaction, command);
    if (scope.context.binding.actorRole !== "untrusted") throw new LifecycleError("SESSION_OWNERSHIP_MISMATCH");
    const authority = authorityOperations(transaction);
    const observed = authority.get(scope.context.binding.projectId, command.childSessionId);
    if (observed === null) throw new LifecycleError("SESSION_NOT_FOUND");
    const child = Object.freeze({ ...observed }) as SessionAuthorityRecord;
    if (child.sessionKind !== "child" || child.parentSessionId === null || child.terminalEventPosition !== null) {
      throw new LifecycleError("SESSION_STATE_CONFLICT");
    }
    const aggregate = authority.requireFoldMatch(child);
    if (aggregate.kind !== "child" || aggregate.state !== "active") throw new LifecycleError("SESSION_STATE_CONFLICT");
    if (BigInt(command.expectedStreamVersion) !== aggregate.streamVersion) throw new LifecycleError("EVENT_CONFLICT");
    const events = authority.loadEvents(child);
    const reportExists = events.some((event) => event.eventType === "ChildWorkReported"
      && event.payload.report.reportId === command.reportId);
    if (!reportExists) throw new LifecycleError("CHILD_REPORT_INVALID");
    const verified = this.#verify(transaction, command, child);
    const now = exactNow(this.#clock);
    const eventPosition = authority.nextGlobalPosition();
    const next: SessionAuthorityRecord = { ...child, semanticState: "completion-proposed", updatedAt: now.timestamp };
    const result: ChildCompletionProposalResultV2 = Object.freeze({
      resultVersion: 2,
      operation: "propose-child-completion",
      childSessionId: child.sessionId,
      parentSessionId: child.parentSessionId,
      reportId: command.reportId,
      state: "completion-proposed",
      eventPosition: eventPosition.toString(),
      finalStreamVersion: (aggregate.streamVersion + 1n).toString(),
    });
    return {
      append: {
        context: scope.context,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.commandType,
        correlationId: aggregate.correlationId,
        agentId: command.agentId,
        expectedStreamVersion: aggregate.streamVersion,
        streamId: child.streamId,
        streamType: "session",
        events: [pendingEvent("ChildCompletionProposed", child.sessionId, child.parentSessionId, now.timestamp, {
          reportId: command.reportId,
        }, latestEventId(events))],
        outbox: [],
        publicResponse: result,
      },
      authorizationRecord: verified.authorizationRecord,
      freshCapabilityGeneration: verified.generation,
      beforeAppend: (_planned, currentTransaction) => {
        if (!authorityOperations(currentTransaction).compareAndSwap({
          projectId: child.projectId,
          sessionId: child.sessionId,
          expectedState: child.semanticState as ChildSessionState,
          expectedOwnerGeneration: null,
          expectedChildCapabilityGeneration: child.childCapabilityGeneration,
          expectedAuthorityCommitment: child.authorityCommitment,
          next: authorityMutation(next),
        })) throw new LifecycleError("EVENT_CONFLICT");
      },
      afterAppend: (committed) => {
        if (committed.events.length !== 1 || committed.events[0]?.globalPosition !== eventPosition) invalid("INTEGRITY_FAILURE");
      },
    };
  }

  #complete(
    transaction: LifecycleCommandTransaction,
    command: CompleteChildSessionCommandV2,
  ): FreshLifecycleEffect<ChildCompletionResultV2> {
    const scope = this.#scope(transaction, command);
    if (scope.context.binding.actorRole !== "primary") throw new LifecycleError("SESSION_OWNERSHIP_MISMATCH");
    const authority = authorityOperations(transaction);
    const { record: parent } = this.#requireCurrentRoot(
      authority,
      scope.context.binding.projectId,
      command.parentSessionId,
    );
    const childObserved = authority.get(scope.context.binding.projectId, command.childSessionId);
    if (childObserved === null) throw new LifecycleError("SESSION_NOT_FOUND");
    const child = Object.freeze({ ...childObserved }) as SessionAuthorityRecord;
    if (child.sessionKind !== "child"
      || child.parentSessionId !== parent.sessionId || child.terminalEventPosition !== null) {
      throw new LifecycleError("SESSION_STATE_CONFLICT");
    }
    const aggregate = authority.requireFoldMatch(child);
    if (aggregate.kind !== "child" || (aggregate.state !== "active" && aggregate.state !== "completion-proposed")) {
      throw new LifecycleError("SESSION_STATE_CONFLICT");
    }
    if (BigInt(command.expectedStreamVersion) !== aggregate.streamVersion) throw new LifecycleError("EVENT_CONFLICT");
    const events = authority.loadEvents(child);
    const reportExists = events.some((event) => event.eventType === "ChildWorkReported"
      && event.payload.report.reportId === command.reportId);
    if (!reportExists || (aggregate.state === "completion-proposed" && aggregate.completionReportId !== command.reportId)) {
      throw new LifecycleError("CHILD_REPORT_INVALID");
    }
    const verified = this.#verify(transaction, command, parent);
    const now = exactNow(this.#clock);
    const eventPosition = authority.nextGlobalPosition();
    const provisional: SessionAuthorityRecord = {
      ...child,
      semanticState: "completed",
      authorityEventPosition: eventPosition,
      revocationReasonCode: "child-completed",
      revocationEventPosition: eventPosition,
      revokedAt: now.timestamp,
      terminalEventPosition: eventPosition,
      terminalEventType: "ChildSessionCompleted",
      terminalAt: now.timestamp,
      updatedAt: now.timestamp,
    };
    const next: SessionAuthorityRecord = {
      ...provisional,
      authorityCommitment: authorityCommitment(committedAuthority(provisional)),
    };
    const result: ChildCompletionResultV2 = Object.freeze({
      resultVersion: 2,
      operation: "complete-child-session",
      childSessionId: child.sessionId,
      parentSessionId: parent.sessionId,
      reportId: command.reportId,
      state: "completed",
      eventPosition: eventPosition.toString(),
      finalStreamVersion: (aggregate.streamVersion + 1n).toString(),
    });
    return {
      append: {
        context: scope.context,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.commandType,
        correlationId: aggregate.correlationId,
        agentId: command.agentId,
        expectedStreamVersion: aggregate.streamVersion,
        streamId: child.streamId,
        streamType: "session",
        events: [pendingEvent("ChildSessionCompleted", child.sessionId, parent.sessionId, now.timestamp, {
          reportId: command.reportId,
          authorityCommitment: next.authorityCommitment,
        }, latestEventId(events))],
        outbox: [],
        publicResponse: result,
      },
      authorizationRecord: verified.authorizationRecord,
      freshCapabilityGeneration: verified.generation,
      beforeAppend: (_planned, currentTransaction) => {
        if (!authorityOperations(currentTransaction).compareAndSwap({
          projectId: child.projectId,
          sessionId: child.sessionId,
          expectedState: child.semanticState as ChildSessionState,
          expectedOwnerGeneration: null,
          expectedChildCapabilityGeneration: child.childCapabilityGeneration,
          expectedAuthorityCommitment: child.authorityCommitment,
          next: authorityMutation(next),
        })) throw new LifecycleError("EVENT_CONFLICT");
      },
      afterAppend: (committed) => {
        if (committed.events.length !== 1 || committed.events[0]?.globalPosition !== eventPosition) invalid("INTEGRITY_FAILURE");
      },
    };
  }
  #suspendAndTransfer(
    transaction: LifecycleCommandTransaction,
    command: SuspendChildSessionCommandV2,
  ): FreshLifecycleEffect<ChildTransferResultV2> {
    const scope = this.#scope(transaction, command);
    if (scope.context.binding.actorRole !== "primary") throw new LifecycleError("SESSION_OWNERSHIP_MISMATCH");
    const authority = authorityOperations(transaction);
    const { record: parent } = this.#requireCurrentRoot(
      authority,
      scope.context.binding.projectId,
      command.parentSessionId,
    );
    const childObserved = authority.get(scope.context.binding.projectId, command.childSessionId);
    if (childObserved === null) throw new LifecycleError("SESSION_NOT_FOUND");
    const child = Object.freeze({ ...childObserved }) as SessionAuthorityRecord;
    if (child.sessionKind !== "child"
      || child.parentSessionId !== parent.sessionId || child.terminalEventPosition !== null) {
      throw new LifecycleError("SESSION_STATE_CONFLICT");
    }
    const aggregate = authority.requireFoldMatch(child);
    if (aggregate.kind !== "child" || (aggregate.state !== "active" && aggregate.state !== "completion-proposed")) {
      throw new LifecycleError("SESSION_STATE_CONFLICT");
    }
    if (BigInt(command.expectedStreamVersion) !== aggregate.streamVersion) throw new LifecycleError("EVENT_CONFLICT");
    const checkpoint = requireRiskyTransitionCheckpointV1({
      authority: child,
      aggregate,
      checkpoint: authority.latestCheckpoint(child),
      explicitCheckpointId: command.checkpointId,
      relevantChildren: [],
    });
    const causationId = latestEventId(authority.loadEvents(child));
    const verified = this.#verify(transaction, command, parent);
    const now = exactNow(this.#clock);
    const suspendedPosition = authority.nextGlobalPosition();
    if (suspendedPosition > SQLITE_INT64_MAX - 1n) invalid("INTEGRITY_FAILURE");
    const transferPosition = suspendedPosition + 1n;
    const transferTicketId = this.#ids.uuid() as TransferTicketId;
    const suspendedProvisional: SessionAuthorityRecord = {
      ...child,
      semanticState: "suspended",
      authorityEventPosition: suspendedPosition,
      revocationReasonCode: "child-suspended",
      revocationEventPosition: suspendedPosition,
      revokedAt: now.timestamp,
      updatedAt: now.timestamp,
    };
    const suspendedCommitment = authorityCommitment(committedAuthority(suspendedProvisional));
    const transferredProvisional: SessionAuthorityRecord = {
      ...suspendedProvisional,
      semanticState: "transferred",
      authorityEventPosition: transferPosition,
      revocationReasonCode: "child-transferred",
      revocationEventPosition: transferPosition,
      terminalEventPosition: transferPosition,
      terminalEventType: "ChildWorkTransferCreated",
      terminalAt: now.timestamp,
    };
    const transferred: SessionAuthorityRecord = {
      ...transferredProvisional,
      authorityCommitment: authorityCommitment(committedAuthority(transferredProvisional)),
    };
    const sourceState = JSON.parse(canonicalJson(checkpoint.sourceState)) as import("../storage/lifecycle-storage.types.js").LifecycleJsonValue;
    const ticket: ChildTransferTicketInsert = Object.freeze({
      projectId: child.projectId,
      transferTicketId,
      sourceParentSessionId: parent.sessionId,
      sourceChildSessionId: child.sessionId,
      sourceAssignment: Object.freeze({
        assignmentId: aggregate.assignment.assignmentId,
        summary: aggregate.assignment.summary,
        scope: aggregate.assignment.scope,
        assignmentRevision: aggregate.assignmentRevision,
      }),
      sourceScope: Object.freeze({ scope: aggregate.assignment.scope }),
      checkpointId: checkpoint.checkpointId,
      blockers: Object.freeze([...command.blockers]),
      followUps: Object.freeze([...command.followUps]),
      sourceState,
      lineage: Object.freeze({
        previousParentSessionId: parent.sessionId,
        previousChildSessionId: child.sessionId,
        correlationId: aggregate.correlationId,
        transferEventPosition: transferPosition.toString(),
      }),
      createdEventPosition: transferPosition,
      createdAtMs: now.milliseconds,
    });
    const result: ChildTransferResultV2 = Object.freeze({
      resultVersion: 2,
      operation: "suspend-child-session",
      childSessionId: child.sessionId,
      parentSessionId: parent.sessionId,
      assignment: Object.freeze({ ...aggregate.assignment }),
      assignmentRevision: aggregate.assignmentRevision.toString(),
      transferTicketId,
      state: "transferred",
      eventPosition: transferPosition.toString(),
      finalStreamVersion: (aggregate.streamVersion + 2n).toString(),
    });
    return {
      append: {
        context: scope.context,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.commandType,
        correlationId: aggregate.correlationId,
        agentId: command.agentId,
        expectedStreamVersion: aggregate.streamVersion,
        streamId: child.streamId,
        streamType: "session",
        events: [
          pendingEvent("ChildSessionSuspended", child.sessionId, parent.sessionId, now.timestamp, {
            checkpointId: command.checkpointId,
            blockers: [...command.blockers],
            followUps: [...command.followUps],
            authorityCommitment: suspendedCommitment,
          }, causationId),
          pendingEvent("ChildWorkTransferCreated", child.sessionId, parent.sessionId, now.timestamp, {
            transferTicketId,
            checkpointId: command.checkpointId,
            authorityCommitment: transferred.authorityCommitment,
          }, PREVIOUS_PENDING_EVENT_CAUSATION),
        ],
        outbox: [],
        publicResponse: result,
      },
      authorizationRecord: verified.authorizationRecord,
      freshCapabilityGeneration: verified.generation,
      beforeAppend: (_planned, currentTransaction) => {
        if (!authorityOperations(currentTransaction).compareAndSwap({
          projectId: child.projectId,
          sessionId: child.sessionId,
          expectedState: child.semanticState as ChildSessionState,
          expectedOwnerGeneration: null,
          expectedChildCapabilityGeneration: child.childCapabilityGeneration,
          expectedAuthorityCommitment: child.authorityCommitment,
          next: authorityMutation(transferred),
        })) throw new LifecycleError("EVENT_CONFLICT");
      },
      afterAppend: (committed, currentTransaction) => {
        if (committed.events.length !== 2
          || committed.events[0]?.globalPosition !== suspendedPosition
          || committed.events[1]?.globalPosition !== transferPosition) invalid("INTEGRITY_FAILURE");
        transferOperations(currentTransaction).insert(ticket);
      },
    };
  }

  #claimTransfer(
    transaction: LifecycleCommandTransaction,
    command: ClaimChildTransferCommandV2,
  ): FreshLifecycleEffect<ClaimChildTransferResultV2> {
    const scope = this.#scope(transaction, command);
    if (scope.context.binding.actorRole !== "primary") throw new LifecycleError("SESSION_OWNERSHIP_MISMATCH");
    const authority = authorityOperations(transaction);
    const transfers = transferOperations(transaction);
    const { record: root, aggregate: rootAggregate } = this.#requireCurrentRoot(
      authority,
      scope.context.binding.projectId,
      command.rootSessionId,
    );
    if (BigInt(command.expectedStreamVersion) !== rootAggregate.streamVersion) throw new LifecycleError("EVENT_CONFLICT");
    const rootOwnerGeneration = root.ownerGeneration;
    if (rootOwnerGeneration === null) invalid("INTEGRITY_FAILURE");
    const ticketObserved = transfers.get(scope.context.binding.projectId, command.transferTicketId);
    if (ticketObserved === null) {
      if (transfers.findCreatedEventPosition(scope.context.binding.projectId, command.transferTicketId) !== null) {
        invalid("INTEGRITY_FAILURE");
      }
      throw new LifecycleError("EVENT_CONFLICT");
    }
    if (ticketObserved.claimedEventPosition !== null) throw new LifecycleError("EVENT_CONFLICT");
    const ticket = Object.freeze({ ...ticketObserved });
    if (ticket.sourceParentSessionId === root.sessionId) throw new LifecycleError("SESSION_STATE_CONFLICT");
    const rootStart = authority.loadEvents(root)[0];
    if (rootStart === undefined || rootStart.eventType !== "SessionStarted"
      || rootStart.sessionId !== root.sessionId || rootStart.parentSessionId !== null
      || BigInt(rootStart.globalPosition) <= ticket.createdEventPosition) {
      throw new LifecycleError("SESSION_STATE_CONFLICT");
    }
    const sourceObserved = authority.get(scope.context.binding.projectId, ticket.sourceChildSessionId);
    if (sourceObserved === null) throw new LifecycleError("SESSION_NOT_FOUND");
    const source = Object.freeze({ ...sourceObserved }) as SessionAuthorityRecord;
    const sourceAggregate = authority.requireFoldMatch(source);
    if (source.sessionKind !== "child" || source.parentSessionId !== ticket.sourceParentSessionId
      || source.semanticState !== "transferred" || source.terminalEventPosition !== ticket.createdEventPosition
      || sourceAggregate.kind !== "child" || sourceAggregate.state !== "transferred") {
      invalid("INTEGRITY_FAILURE");
    }
    const sourceEvents = authority.loadEvents(source);
    const transferEventIndex = sourceEvents.findIndex((event) =>
      event.eventType === "ChildWorkTransferCreated"
      && BigInt(event.globalPosition) === ticket.createdEventPosition
      && event.payload.transferTicketId === ticket.transferTicketId);
    const transferEvent = sourceEvents[transferEventIndex];
    const suspensionEvent = sourceEvents[transferEventIndex - 1];
    const checkpoint = authority.latestCheckpoint(source);
    if (transferEvent === undefined || transferEvent.eventType !== "ChildWorkTransferCreated"
      || suspensionEvent === undefined || suspensionEvent.eventType !== "ChildSessionSuspended"
      || checkpoint === null
      || transferEvent.payload.checkpointId !== ticket.checkpointId
      || suspensionEvent.payload.checkpointId !== ticket.checkpointId
      || sourceAggregate.suspensionCheckpointId !== ticket.checkpointId
      || sourceAggregate.latestCheckpointId !== ticket.checkpointId
      || ticket.createdAtMs !== BigInt(Date.parse(transferEvent.occurredAt))
      || canonicalJson(ticket.sourceAssignment) !== canonicalJson({
        assignmentId: sourceAggregate.assignment.assignmentId,
        summary: sourceAggregate.assignment.summary,
        scope: sourceAggregate.assignment.scope,
        assignmentRevision: sourceAggregate.assignmentRevision,
      })
      || canonicalJson(ticket.sourceScope) !== canonicalJson({ scope: sourceAggregate.assignment.scope })
      || canonicalJson(ticket.sourceState) !== canonicalJson(checkpoint.sourceState)
      || canonicalJson(ticket.lineage) !== canonicalJson({
        previousParentSessionId: source.parentSessionId,
        previousChildSessionId: source.sessionId,
        correlationId: sourceAggregate.correlationId,
        transferEventPosition: ticket.createdEventPosition.toString(),
      })
      || canonicalJson(ticket.blockers) !== canonicalJson(suspensionEvent.payload.blockers)
      || canonicalJson(ticket.followUps) !== canonicalJson(suspensionEvent.payload.followUps)) {
      invalid("INTEGRITY_FAILURE");
    }
    const assignment = ticket.sourceAssignment as Readonly<Record<string, JsonValue>>;
    if (typeof assignment.assignmentId !== "string" || typeof assignment.summary !== "string"
      || typeof assignment.scope !== "string") invalid("INTEGRITY_FAILURE");
    const verified = this.#verify(transaction, command, root);
    requireRiskyTransitionCheckpointV1({
      authority: root,
      aggregate: rootAggregate,
      checkpoint: authority.latestCheckpoint(root),
      minimumBaseEventPosition: ticket.createdEventPosition,
      relevantChildren: riskyTransitionChildren(authority, root),
    });
    const now = exactNow(this.#clock);
    const forkPosition = authority.nextGlobalPosition();
    if (forkPosition > SQLITE_INT64_MAX - 1n) invalid("INTEGRITY_FAILURE");
    const claimPosition = forkPosition + 1n;
    const childSessionId = this.#ids.uuid();
    const child = childRecord({
      context: scope.context,
      parent: root,
      childSessionId,
      eventPosition: forkPosition,
      now: now.timestamp,
      material: null,
    });
    const result: ClaimChildTransferResultV2 = Object.freeze({
      resultVersion: 2,
      operation: "claim-child-transfer",
      childSessionId,
      parentSessionId: root.sessionId,
      previousChildSessionId: source.sessionId,
      transferTicketId: ticket.transferTicketId,
      assignment: Object.freeze({
        assignmentId: assignment.assignmentId,
        summary: assignment.summary,
        scope: assignment.scope,
      }),
      assignmentRevision: "1",
      directAccessEnabled: false,
      rootOwnerGeneration: rootOwnerGeneration.toString(),
      state: "active",
      eventPosition: claimPosition.toString(),
      finalStreamVersion: "2",
    });
    return {
      append: {
        context: scope.context,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        commandType: command.commandType,
        correlationId: rootAggregate.correlationId,
        agentId: command.agentId,
        expectedStreamVersion: 0n,
        streamId: child.streamId,
        streamType: "session",
        events: [
          pendingEvent("SessionForked", child.sessionId, root.sessionId, now.timestamp, {
            parentSessionId: root.sessionId,
            assignment: {
              assignmentId: assignment.assignmentId,
              summary: assignment.summary,
              scope: assignment.scope,
            },
            rootOwnerGeneration: Number(rootOwnerGeneration),
            directAccessEnabled: false,
            authorityCommitment: child.authorityCommitment,
            sourceTransferTicketId: ticket.transferTicketId,
          }, transferEvent.eventId),
          pendingEvent("ChildWorkTransferClaimed", child.sessionId, root.sessionId, now.timestamp, {
            transferTicketId: ticket.transferTicketId,
            previousChildSessionId: source.sessionId,
            previousTransferEventPosition: ticket.createdEventPosition.toString(),
          }, PREVIOUS_PENDING_EVENT_CAUSATION),
        ],
        outbox: [],
        publicResponse: result,
      },
      authorizationRecord: verified.authorizationRecord,
      freshCapabilityGeneration: verified.generation,
      afterAppend: (committed, currentTransaction) => {
        if (committed.events.length !== 2
          || committed.events[0]?.globalPosition !== forkPosition
          || committed.events[1]?.globalPosition !== claimPosition) invalid("INTEGRITY_FAILURE");
        const currentAuthority = authorityOperations(currentTransaction);
        const currentTransfers = transferOperations(currentTransaction);
        currentAuthority.insertChild(child);
        currentAuthority.markCheckpointRequired({
          projectId: child.projectId,
          sessionId: child.sessionId,
          reason: "carry-forward-claim",
          eventPosition: claimPosition,
          updatedAt: now.timestamp,
        });
        this.#faultInjector?.("after-child-effects-before-ticket-cas");
        currentTransfers.claim({
          projectId: root.projectId,
          transferTicketId: ticket.transferTicketId,
          expectedCreatedEventPosition: ticket.createdEventPosition,
          claimedByRootSessionId: root.sessionId,
          claimedChildSessionId: child.sessionId,
          claimedEventPosition: claimPosition,
          claimedAtMs: now.milliseconds,
        });
      },
    };
  }

}
