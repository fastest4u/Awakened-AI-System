import type { ProjectContext } from "../identity/contracts.js";
import type { ProjectBinding } from "../projections/contracts.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import type { CapabilityService, StoredCapabilityMaterialV1 } from "../lifecycle/capability.service.js";
import { decodeCapabilityProofTarget, type SemanticCommandProofTargetV1, type BoundedOperationProofTargetV1 } from "../lifecycle/authority/capability-codec.js";
import { LifecycleError } from "../lifecycle/errors.js";
import { parseCanonicalTimestamp, parseCanonicalUuid } from "../lifecycle/contracts/identifiers.js";
import { SessionAuthorityRepository } from "../storage/session-authority.repository.js";
import type { SessionAuthorityRecord } from "../storage/lifecycle-storage.types.js";
import { BranchScopeRepository } from "../storage/branch-scope.repository.js";
import { commandHash } from "../crypto/event-hash.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { boundedRetainedJson, RetainedEvidenceError } from "../privacy/evidence-contracts.js";
import { decodeRetainedEvidenceAuthority } from "../privacy/retained-evidence-codec.js";
import type { GovernedNoteCommandV1, GovernedNoteRecoveryV1, GovernedNoteClockV1, GovernedNoteAuthoritySnapshotV1, PreparedGovernedNoteCreateV1, PreparedGovernedNoteRecoveryV1, GovernedNoteCommandV2, GovernedNoteRecoveryV2, PreparedGovernedNoteCreateV2, PreparedGovernedNoteRecoveryV2 } from "./contracts.js";
import { decodeGovernedNoteCommandV1, decodeGovernedNoteRecoveryV1, encodePreparedGovernedNoteCreateV1, decodePreparedGovernedNoteCreateV1, encodePreparedGovernedNoteRecoveryV1, decodePreparedGovernedNoteRecoveryV1, decodeGovernedNoteCommandV2, decodeGovernedNoteRecoveryV2, encodePreparedGovernedNoteCreateV2, decodePreparedGovernedNoteCreateV2, encodePreparedGovernedNoteRecoveryV2, decodePreparedGovernedNoteRecoveryV2 } from "./codec.js";
import { GovernedNoteError, type GovernedNoteErrorCode } from "./errors.js";

declare const createBrand: unique symbol;
declare const recoveryBrand: unique symbol;
export interface VerifiedGovernedNoteCreateAuthority { readonly [createBrand]: true }
export interface VerifiedGovernedNoteRecoveryAuthority { readonly [recoveryBrand]: true }
export type GovernedNoteCreateProofScopeV1 = Omit<SemanticCommandProofTargetV1, "proofVersion" | "target" | "commandId" | "idempotencyKey" | "intentHash" | "proofNonce">;
const refuse = (code: GovernedNoteErrorCode = "SESSION_CAPABILITY_INVALID"): never => { throw new GovernedNoteError(code); };
function noteNonce(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) refuse();
  return value;
}
function safe<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof GovernedNoteError) throw error;
    if ((error instanceof LifecycleError || error instanceof RetainedEvidenceError) && ["SESSION_CAPABILITY_INVALID", "SESSION_CAPABILITY_KEY_UNAVAILABLE", "SESSION_CAPABILITY_EXPIRED", "SESSION_NOT_FOUND", "SESSION_HANDLE_STALE", "SESSION_OWNERSHIP_MISMATCH", "INTEGRITY_FAILURE"].includes(error.code)) refuse(error.code as GovernedNoteErrorCode);
    return refuse();
  }
}
function noteSnapshot(value: unknown): GovernedNoteAuthoritySnapshotV1 {
  const snapshot = decodeRetainedEvidenceAuthority(value);
  if ((snapshot.capabilityKind !== "root-session-handle" && snapshot.capabilityKind !== "child-session-handle")
    || snapshot.authorizationSessionId !== snapshot.targetSessionId || snapshot.presentingActorRole !== snapshot.targetActorRole
    || snapshot.presentingClientInstanceId !== snapshot.targetClientInstanceId) refuse("SESSION_OWNERSHIP_MISMATCH");
  for (const generation of [snapshot.rootOwnerGeneration, snapshot.authorizingOwnerGeneration, snapshot.authorizingCapabilityGeneration, snapshot.targetOwnerGeneration, snapshot.targetCapabilityGeneration]) {
    if (generation !== null && (BigInt(generation) < 1n || BigInt(generation) > 9223372036854775807n)) refuse("INTEGRITY_FAILURE");
  }
  return snapshot as GovernedNoteAuthoritySnapshotV1;
}
export function deriveGovernedNoteBinding(connection: SqliteConnection, context: ProjectContext, targetSessionId: string): ProjectBinding {
  return safe(() => {
    const b = context.binding, workspace = context.workspace;
    parseCanonicalUuid(targetSessionId, "governed-note");
    if (workspace.workspaceId !== b.workspaceId) refuse("SESSION_OWNERSHIP_MISMATCH");
    const branchScopeId = workspace.kind === "git" ? new BranchScopeRepository().inspect(connection, b.projectId, workspace) : null;
    if (context.branchScopeId !== undefined && context.branchScopeId !== branchScopeId) refuse("SESSION_OWNERSHIP_MISMATCH");
    return Object.freeze({ projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId, branchScopeId, branchRef: workspace.kind === "git" ? workspace.branchRef : null, sessionId: targetSessionId });
  });
}
export function governedNoteCreateProofTarget(command: GovernedNoteCommandV1, scope: GovernedNoteCreateProofScopeV1, binding: ProjectBinding, proofNonce: string): SemanticCommandProofTargetV1 {
  return safe(() => {
    const owned = decodeGovernedNoteCommandV1(command);
    if (scope.authoritySessionId !== scope.targetSessionId || binding.sessionId !== scope.targetSessionId
      || scope.presentingActorRole !== scope.targetActorRole || scope.presentingClientInstanceId !== scope.targetClientInstanceId
      || (scope.capabilityKind !== "root-session-handle" && scope.capabilityKind !== "child-session-handle")) refuse("SESSION_OWNERSHIP_MISMATCH");
    return decodeCapabilityProofTarget({ ...scope, proofVersion: 1, target: "semantic-command", commandId: owned.commandId, idempotencyKey: owned.idempotencyKey,
      intentHash: commandHash({ proofPurpose: "create-governed-note/v1", scope, binding, originalCommand: canonicalJson(owned) }), proofNonce: noteNonce(proofNonce) }) as SemanticCommandProofTargetV1;
  });
}
export function governedNoteRecoveryProofTarget(request: GovernedNoteRecoveryV1, context: ProjectContext, binding: ProjectBinding, capabilityGeneration: string, proofNonce: string): BoundedOperationProofTargetV1 {
  return safe(() => {
    const owned = decodeGovernedNoteRecoveryV1(request), b = context.binding;
    if (binding.sessionId === null) refuse("SESSION_OWNERSHIP_MISMATCH");
    const selectors = { projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId, clientNamespace: b.clientNamespace,
      branchScopeId: binding.branchScopeId, branchRef: binding.branchRef, authoritySessionId: binding.sessionId, targetSessionId: binding.sessionId,
      commandId: owned.commandId, idempotencyKey: owned.idempotencyKey, operationId: owned.operationId, requestId: owned.requestId,
      presentingActorRole: b.actorRole, presentingClientInstanceId: b.clientInstanceId, targetActorRole: b.actorRole, targetClientInstanceId: b.clientInstanceId, expiresAt: owned.expiresAt };
    return decodeCapabilityProofTarget({ proofVersion: 1, target: "bounded-operation", operationType: owned.operation, operationId: owned.operationId, requestId: owned.requestId,
      operationHash: commandHash({ proofPurpose: "recover-governed-note-result/v1", ...selectors }), authoritySessionId: binding.sessionId, targetSessionId: binding.sessionId,
      presentingActorRole: b.actorRole, presentingClientInstanceId: b.clientInstanceId, targetActorRole: b.actorRole, targetClientInstanceId: b.clientInstanceId,
      capabilityGeneration, proofNonce: noteNonce(proofNonce), expiresAt: owned.expiresAt }) as BoundedOperationProofTargetV1;
  });
}

export function governedNoteCreateProofTargetV2(command: GovernedNoteCommandV2, scope: GovernedNoteCreateProofScopeV1, binding: ProjectBinding, proofNonce: string): SemanticCommandProofTargetV1 {
  return safe(() => {
    const owned = decodeGovernedNoteCommandV2(command);
    if (scope.authoritySessionId !== scope.targetSessionId || binding.sessionId !== scope.targetSessionId
      || scope.presentingActorRole !== scope.targetActorRole || scope.presentingClientInstanceId !== scope.targetClientInstanceId
      || (scope.capabilityKind !== "root-session-handle" && scope.capabilityKind !== "child-session-handle")) refuse("SESSION_OWNERSHIP_MISMATCH");
    return decodeCapabilityProofTarget({ ...scope, proofVersion: 1, target: "semantic-command", commandId: owned.commandId, idempotencyKey: owned.idempotencyKey,
      intentHash: commandHash({ proofPurpose: "create-governed-note/v2", scope, binding, originalCommand: canonicalJson(owned) }), proofNonce: noteNonce(proofNonce) }) as SemanticCommandProofTargetV1;
  });
}
export function governedNoteRecoveryProofTargetV2(request: GovernedNoteRecoveryV2, context: ProjectContext, binding: ProjectBinding, capabilityGeneration: string, proofNonce: string): BoundedOperationProofTargetV1 {
  return safe(() => {
    const owned = decodeGovernedNoteRecoveryV2(request), b = context.binding;
    if (binding.sessionId === null) refuse("SESSION_OWNERSHIP_MISMATCH");
    const selectors = { projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId, clientNamespace: b.clientNamespace,
      branchScopeId: binding.branchScopeId, branchRef: binding.branchRef, authoritySessionId: binding.sessionId, targetSessionId: binding.sessionId,
      commandId: owned.commandId, idempotencyKey: owned.idempotencyKey, operationId: owned.operationId, requestId: owned.requestId,
      presentingActorRole: b.actorRole, presentingClientInstanceId: b.clientInstanceId, targetActorRole: b.actorRole, targetClientInstanceId: b.clientInstanceId, expiresAt: owned.expiresAt };
    return decodeCapabilityProofTarget({ proofVersion: 1, target: "bounded-operation", operationType: owned.operation, operationId: owned.operationId, requestId: owned.requestId,
      operationHash: commandHash({ proofPurpose: "recover-governed-note-result/v2", ...selectors }), authoritySessionId: binding.sessionId, targetSessionId: binding.sessionId,
      presentingActorRole: b.actorRole, presentingClientInstanceId: b.clientInstanceId, targetActorRole: b.actorRole, targetClientInstanceId: b.clientInstanceId,
      capabilityGeneration, proofNonce: noteNonce(proofNonce), expiresAt: owned.expiresAt }) as BoundedOperationProofTargetV1;
  });
}

type Admitted<P> = Readonly<{ connection: SqliteConnection; verifier: GovernedNoteAuthorityVerifier; prepared: P; context: ProjectContext; canonical: string; snapshot: GovernedNoteAuthoritySnapshotV1; binding: ProjectBinding; operation: string }>;
const creates = new WeakMap<object, Admitted<PreparedGovernedNoteCreateV1 | PreparedGovernedNoteCreateV2>>();
const recoveries = new WeakMap<object, Admitted<PreparedGovernedNoteRecoveryV1 | PreparedGovernedNoteRecoveryV2>>();
function storedHandle(context: ProjectContext, row: SessionAuthorityRecord): StoredCapabilityMaterialV1 {
  const root = row.sessionKind === "root";
  const generation = root ? row.ownerGeneration : row.childCapabilityGeneration;
  const version = root ? row.rootHandleCapabilityVersion : row.childHandleCapabilityVersion;
  const keyId = root ? row.rootHandleKeyId : row.childHandleKeyId;
  const issueNonce = root ? row.rootHandleIssueNonce : row.childHandleIssueNonce;
  const issuedAt = root ? row.rootHandleIssuedAt : row.childHandleIssuedAt;
  const policyCode = root ? row.rootHandlePolicyCode : row.childHandlePolicyCode;
  const expiryKind = root ? row.rootHandleExpiryKind : row.childHandleExpiryKind;
  const expiresAt = root ? row.rootHandleExpiresAt : row.childHandleExpiresAt;
  const actorRole = root ? row.rootHandleActorRole : row.childHandleActorRole;
  const clientInstanceId = root ? row.rootHandleClientInstanceId : row.childHandleClientInstanceId;
  const verifier = root ? row.rootHandleVerifier : row.childHandleVerifier;
  if (generation === null || version !== 1 || keyId === null || issueNonce === null || issuedAt === null
    || policyCode === null || expiryKind === null || actorRole === null || clientInstanceId === null || verifier === null) return refuse("INTEGRITY_FAILURE");
  return { claims: { capabilityVersion: 1, keyId, projectId: row.projectId, vaultId: context.binding.vaultId,
    storeId: context.binding.storeId, workspaceId: row.workspaceId, clientNamespace: row.clientNamespace,
    sessionId: row.sessionId, kind: root ? "root-session-handle" : "child-session-handle", capabilityGeneration: generation.toString(),
    issuedAt, policyCode, expiryKind, expiresAt, issueNonce, actorRole, clientInstanceId }, verifier };
}

function current(row: SessionAuthorityRecord): void {
  if (row.revocationEventPosition !== null || row.revokedAt !== null || row.terminalEventPosition !== null
    || row.terminalAt !== null || row.terminalEventType !== null || (row.sessionKind === "root" && row.semanticState !== "active")) refuse("SESSION_HANDLE_STALE");
}
export class GovernedNoteAuthorityVerifier {
  readonly #connection: SqliteConnection;
  readonly #capabilities: CapabilityService;
  readonly #clock: GovernedNoteClockV1;
  readonly #repository = new SessionAuthorityRepository();
  constructor(options: { connection: SqliteConnection; capabilities: CapabilityService; clock: GovernedNoteClockV1 }) {
    this.#connection = options.connection; this.#capabilities = options.capabilities; this.#clock = options.clock;
  }
  private inspectScope(context: ProjectContext, authoritySessionId: string, targetSessionId: string): { snapshot: GovernedNoteAuthoritySnapshotV1; material: StoredCapabilityMaterialV1; scope: GovernedNoteCreateProofScopeV1 } {
    if (authoritySessionId !== targetSessionId) refuse("SESSION_OWNERSHIP_MISMATCH");
    const b = context.binding;
    const identity = this.#connection.prepare("SELECT project_id, vault_id, store_id FROM project_meta WHERE singleton = 1").get();
    if (!identity || identity.project_id !== b.projectId || identity.vault_id !== b.vaultId || identity.store_id !== b.storeId) refuse("SESSION_OWNERSHIP_MISMATCH");
    const authorizer = this.#repository.get(this.#connection, b.projectId, authoritySessionId);
    const target = this.#repository.get(this.#connection, b.projectId, targetSessionId);
    if (!authorizer || !target) return refuse("SESSION_NOT_FOUND");
    current(authorizer); current(target);
    if (authorizer.workspaceId !== b.workspaceId || target.workspaceId !== b.workspaceId
      || authorizer.clientNamespace !== b.clientNamespace || target.clientNamespace !== b.clientNamespace
      || (authorizer.sessionKind === "root" ? b.actorRole !== "primary" || authorizer.rootHandleClientInstanceId !== b.clientInstanceId
        : b.actorRole !== "untrusted" || authorizer.childHandleClientInstanceId !== b.clientInstanceId || !authorizer.directAccessEnabled)) refuse("SESSION_OWNERSHIP_MISMATCH");
    this.#repository.requireFoldMatch(this.#connection, authorizer);
    const aggregate = this.#repository.requireFoldMatch(this.#connection, target);
    if (aggregate.vaultId !== b.vaultId || aggregate.storeId !== b.storeId || aggregate.parentSessionId !== target.parentSessionId
      || aggregate.authorityCommitment !== target.authorityCommitment) refuse("INTEGRITY_FAILURE");
    const rootId = target.sessionKind === "root" ? target.sessionId : target.parentSessionId;
    if (rootId === null) return refuse("INTEGRITY_FAILURE");
    const root = this.#repository.get(this.#connection, b.projectId, rootId);
    if (!root) return refuse("SESSION_NOT_FOUND");
    current(root); this.#repository.requireFoldMatch(this.#connection, root);
    if (root.sessionKind !== "root" || root.parentSessionId !== null || root.ownerGeneration === null
      || root.workspaceId !== b.workspaceId || root.clientNamespace !== b.clientNamespace
      || (aggregate.kind === "child" && BigInt(aggregate.rootOwnerGeneration) !== root.ownerGeneration)) return refuse("SESSION_HANDLE_STALE");
    const material = storedHandle(context, authorizer);
    const scope: GovernedNoteCreateProofScopeV1 = { projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace, authoritySessionId: authorizer.sessionId, targetSessionId: target.sessionId,
      presentingActorRole: b.actorRole, presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: b.actorRole, targetClientInstanceId: b.clientInstanceId,
      capabilityKind: material.claims.kind, capabilityGeneration: material.claims.capabilityGeneration };
    const snapshot = noteSnapshot({ projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace, presentingActorRole: b.actorRole, presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: b.actorRole, targetClientInstanceId: b.clientInstanceId, authorizationSessionId: authorizer.sessionId,
      targetSessionId: target.sessionId, parentSessionId: target.parentSessionId, rootSessionId: root.sessionId,
      rootOwnerGeneration: root.ownerGeneration.toString(), authorizingOwnerGeneration: authorizer.ownerGeneration?.toString() ?? null,
      authorizingCapabilityGeneration: authorizer.childCapabilityGeneration?.toString() ?? null, targetOwnerGeneration: target.ownerGeneration?.toString() ?? null,
      targetCapabilityGeneration: target.childCapabilityGeneration?.toString() ?? null, capabilityKind: material.claims.kind });
    return { snapshot, material, scope };
  }
  private inspectCreate(prepared: PreparedGovernedNoteCreateV1 | PreparedGovernedNoteCreateV2, context: ProjectContext) {
    const a = prepared.authorization;
    const { snapshot, material, scope } = this.inspectScope(context, a.authoritySessionId, a.targetSessionId);
    const binding = deriveGovernedNoteBinding(this.#connection, context, a.targetSessionId);
    const target = prepared.command.version === 2 ? governedNoteCreateProofTargetV2(prepared.command, scope, binding, a.proof!.proofNonce) : governedNoteCreateProofTarget(prepared.command, scope, binding, a.proof!.proofNonce);
    this.#capabilities.verifyProof(material, target, a.proof!);
    return { snapshot, binding };
  }
  private expiry(request: GovernedNoteRecoveryV1 | GovernedNoteRecoveryV2): void {
    const expiresAt = BigInt(Date.parse(parseCanonicalTimestamp(request.expiresAt, "governed-note")));
    if (this.#clock.nowMs() >= expiresAt) refuse("SESSION_CAPABILITY_EXPIRED");
  }
  private inspectRecovery(prepared: PreparedGovernedNoteRecoveryV1 | PreparedGovernedNoteRecoveryV2, context: ProjectContext) {
    const a = prepared.authorization;
    const { snapshot, material } = this.inspectScope(context, a.authoritySessionId, a.targetSessionId);
    const binding = deriveGovernedNoteBinding(this.#connection, context, a.targetSessionId);
    const target = prepared.request.version === 2 ? governedNoteRecoveryProofTargetV2(prepared.request, context, binding, material.claims.capabilityGeneration, a.proof.proofNonce) : governedNoteRecoveryProofTarget(prepared.request, context, binding, material.claims.capabilityGeneration, a.proof.proofNonce);
    for (const field of ["presentingActorRole", "presentingClientInstanceId", "targetActorRole", "targetClientInstanceId"] as const) {
      if (a.audience[field] !== target[field]) refuse("SESSION_OWNERSHIP_MISMATCH");
    }
    this.#capabilities.verifyProof(material, target, a.proof);
    this.expiry(prepared.request);
    return { snapshot, binding };
  }
  verifyCreate(prepared: PreparedGovernedNoteCreateV1, context: ProjectContext): VerifiedGovernedNoteCreateAuthority {
    return safe(() => {
      // Reject broader retained authority before decoding or verifying its proof.
      if (prepared.authorization.authoritySessionId !== prepared.authorization.targetSessionId) refuse("SESSION_OWNERSHIP_MISMATCH");
      const owned = decodePreparedGovernedNoteCreateV1(encodePreparedGovernedNoteCreateV1(prepared));
      const ownedContext = boundedRetainedJson(context, 8192).snapshot as unknown as ProjectContext;
      const inspected = this.inspectCreate(owned, ownedContext), handle = Object.freeze(Object.create(null)) as VerifiedGovernedNoteCreateAuthority;
      creates.set(handle, { connection: this.#connection, verifier: this, prepared: owned, context: ownedContext, canonical: canonicalJson(owned.command), operation: "create-governed-note", ...inspected });
      return handle;
    });
  }
  verifyRecovery(prepared: PreparedGovernedNoteRecoveryV1, context: ProjectContext): VerifiedGovernedNoteRecoveryAuthority {
    return safe(() => {
      if (prepared.authorization.authoritySessionId !== prepared.authorization.targetSessionId) refuse("SESSION_OWNERSHIP_MISMATCH");
      const owned = decodePreparedGovernedNoteRecoveryV1(encodePreparedGovernedNoteRecoveryV1(prepared));
      const ownedContext = boundedRetainedJson(context, 8192).snapshot as unknown as ProjectContext;
      const inspected = this.inspectRecovery(owned, ownedContext), handle = Object.freeze(Object.create(null)) as VerifiedGovernedNoteRecoveryAuthority;
      recoveries.set(handle, { connection: this.#connection, verifier: this, prepared: owned, context: ownedContext, canonical: canonicalJson(owned.request), operation: "recover-governed-note-result", ...inspected });
      return handle;
    });
  }
  verifyCreateV2(prepared: PreparedGovernedNoteCreateV2, context: ProjectContext): VerifiedGovernedNoteCreateAuthority {
    return safe(() => {
      // Reject broader retained authority before decoding or verifying its proof.
      if (prepared.authorization.authoritySessionId !== prepared.authorization.targetSessionId) refuse("SESSION_OWNERSHIP_MISMATCH");
      const owned = decodePreparedGovernedNoteCreateV2(encodePreparedGovernedNoteCreateV2(prepared));
      const ownedContext = boundedRetainedJson(context, 8192).snapshot as unknown as ProjectContext;
      const inspected = this.inspectCreate(owned, ownedContext), handle = Object.freeze(Object.create(null)) as VerifiedGovernedNoteCreateAuthority;
      creates.set(handle, { connection: this.#connection, verifier: this, prepared: owned, context: ownedContext, canonical: canonicalJson(owned.command), operation: "create-governed-note", ...inspected });
      return handle;
    });
  }
  verifyRecoveryV2(prepared: PreparedGovernedNoteRecoveryV2, context: ProjectContext): VerifiedGovernedNoteRecoveryAuthority {
    return safe(() => {
      if (prepared.authorization.authoritySessionId !== prepared.authorization.targetSessionId) refuse("SESSION_OWNERSHIP_MISMATCH");
      const owned = decodePreparedGovernedNoteRecoveryV2(encodePreparedGovernedNoteRecoveryV2(prepared));
      const ownedContext = boundedRetainedJson(context, 8192).snapshot as unknown as ProjectContext;
      const inspected = this.inspectRecovery(owned, ownedContext), handle = Object.freeze(Object.create(null)) as VerifiedGovernedNoteRecoveryAuthority;
      recoveries.set(handle, { connection: this.#connection, verifier: this, prepared: owned, context: ownedContext, canonical: canonicalJson(owned.request), operation: "recover-governed-note-result", ...inspected });
      return handle;
    });
  }
  private createState(handle: VerifiedGovernedNoteCreateAuthority) {
    const state = creates.get(handle);
    if (!state || state.connection !== this.#connection || state.verifier !== this || state.operation !== "create-governed-note") return refuse();
    return state;
  }
  private recoveryState(handle: VerifiedGovernedNoteRecoveryAuthority) {
    const state = recoveries.get(handle);
    if (!state || state.connection !== this.#connection || state.verifier !== this || state.operation !== "recover-governed-note-result") return refuse();
    return state;
  }
  private compare(admitted: { snapshot: GovernedNoteAuthoritySnapshotV1; binding: ProjectBinding }, current: { snapshot: GovernedNoteAuthoritySnapshotV1; binding: ProjectBinding }): GovernedNoteAuthoritySnapshotV1 {
    if (canonicalJson(current.binding) !== canonicalJson(admitted.binding)) refuse("SESSION_OWNERSHIP_MISMATCH");
    if (canonicalJson(current.snapshot) !== canonicalJson(admitted.snapshot)) refuse("SESSION_HANDLE_STALE");
    return current.snapshot;
  }
  revalidateCreate(handle: VerifiedGovernedNoteCreateAuthority): GovernedNoteAuthoritySnapshotV1 {
    return safe(() => {
      const state = this.createState(handle);
      if (canonicalJson(deriveGovernedNoteBinding(this.#connection, state.context, state.prepared.authorization.targetSessionId)) !== canonicalJson(state.binding)) refuse("SESSION_OWNERSHIP_MISMATCH");
      return this.compare(state, this.inspectCreate(state.prepared, state.context));
    });
  }
  revalidateRecovery(handle: VerifiedGovernedNoteRecoveryAuthority): GovernedNoteAuthoritySnapshotV1 {
    return safe(() => {
      const state = this.recoveryState(handle);
      if (canonicalJson(deriveGovernedNoteBinding(this.#connection, state.context, state.prepared.authorization.targetSessionId)) !== canonicalJson(state.binding)) refuse("SESSION_OWNERSHIP_MISMATCH");
      return this.compare(state, this.inspectRecovery(state.prepared, state.context));
    });
  }
  bindingForCreate(handle: VerifiedGovernedNoteCreateAuthority): ProjectBinding { return this.createState(handle).binding; }
  bindingForRecovery(handle: VerifiedGovernedNoteRecoveryAuthority): ProjectBinding { return this.recoveryState(handle).binding; }
  /** The service calls this after final live verification, immediately before detach. */
  assertRecoveryUnexpired(handle: VerifiedGovernedNoteRecoveryAuthority): void {
    safe(() => this.expiry(this.recoveryState(handle).prepared.request));
  }
  /** Revoke this attempt's transient authority even when its read disposition fails. */
  discardRecovery(handle: VerifiedGovernedNoteRecoveryAuthority): void {
    this.recoveryState(handle);
    recoveries.delete(handle);
  }
}
export function requireGovernedNoteCreateAuthority(connection: SqliteConnection, handle: VerifiedGovernedNoteCreateAuthority, command: GovernedNoteCommandV1, expectedBinding?: ProjectBinding): GovernedNoteAuthoritySnapshotV1 {
  return safe(() => {
    const state = creates.get(handle);
    if (!state || state.connection !== connection || state.operation !== "create-governed-note" || state.prepared.command.version !== 1 || canonicalJson(decodeGovernedNoteCommandV1(command)) !== state.canonical) return refuse();
    const snapshot = state.verifier.revalidateCreate(handle);
    // The expected value is only an assertion: authority comes from the owned,
    // revalidated binding captured with this exact handle and original command.
    if (expectedBinding !== undefined && canonicalJson(expectedBinding) !== canonicalJson(state.binding)) refuse("SESSION_OWNERSHIP_MISMATCH");
    return snapshot;
  });
}

export function requireGovernedNoteCreateAuthorityV2(connection: SqliteConnection, handle: VerifiedGovernedNoteCreateAuthority, command: GovernedNoteCommandV2, expectedBinding?: ProjectBinding): GovernedNoteAuthoritySnapshotV1 {
  return safe(() => {
    const state = creates.get(handle);
    if (!state || state.connection !== connection || state.operation !== "create-governed-note" || state.prepared.command.version !== 2 || canonicalJson(decodeGovernedNoteCommandV2(command)) !== state.canonical) return refuse();
    const snapshot = state.verifier.revalidateCreate(handle);
    // The expected value is only an assertion: authority comes from the owned,
    // revalidated binding captured with this exact handle and original command.
    if (expectedBinding !== undefined && canonicalJson(expectedBinding) !== canonicalJson(state.binding)) refuse("SESSION_OWNERSHIP_MISMATCH");
    return snapshot;
  });
}
