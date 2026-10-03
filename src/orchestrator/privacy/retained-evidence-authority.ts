import type { ProjectContext } from "../identity/contracts.js";
import type { SemanticCommandAuthorization } from "../lifecycle/contracts/commands.js";
import type { CapabilityService, StoredCapabilityMaterialV1 } from "../lifecycle/capability.service.js";
import type { SemanticCommandProofTargetV1 } from "../lifecycle/authority/capability-codec.js";
import { SessionAuthorityRepository } from "../storage/session-authority.repository.js";
import type { SessionAuthorityRecord } from "../storage/lifecycle-storage.types.js";
import { commandHash } from "../crypto/event-hash.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import type { RetainedEvidenceAuthoritySnapshotV1 } from "./retained-evidence-intent.js";
import { boundedRetainedJson, decodeRetainEvidenceBatch, retainedExactRecord, RetainedEvidenceError, RETAINED_EVIDENCE_LIMITS, type BoundedEvidenceInputV1, type RetainEvidenceBatchCommandV1 } from "./evidence-contracts.js";
import { decodeRetainedEvidenceAuthority } from "./retained-evidence-codec.js";

export interface RetainedEvidenceInvocationV1 { readonly context: ProjectContext; readonly input: BoundedEvidenceInputV1; readonly authorization: SemanticCommandAuthorization; }
declare const verifiedBrand: unique symbol;
export interface VerifiedRetainedEvidenceAuthority { readonly [verifiedBrand]: true; }
type ProofScope = Omit<SemanticCommandProofTargetV1, "proofVersion" | "target" | "commandId" | "idempotencyKey" | "intentHash" | "proofNonce">;
type VerifiedState = { readonly connection: SqliteConnection; readonly verifier: RetainedEvidenceAuthorityVerifier; readonly invocation: RetainedEvidenceInvocationV1; readonly commandCanonical: string; readonly snapshot: RetainedEvidenceAuthoritySnapshotV1; readonly operation: "retain-evidence-batch" };
const verified = new WeakMap<object, VerifiedState>();
const refuse = (code: "SESSION_CAPABILITY_INVALID" | "SESSION_NOT_FOUND" | "SESSION_HANDLE_STALE" | "SESSION_OWNERSHIP_MISMATCH" | "INTEGRITY_FAILURE" = "SESSION_CAPABILITY_INVALID"): never => { throw new RetainedEvidenceError(code); };

/** Shared private-boundary proof builder. The original command is a bounded canonical STRING
 * inside the old shallow commandHash material, so deep JSON never enters its recursive serializer.
 * The returned digest is transient capability intent, never the durable retained witness hash. */
export function retainedEvidenceProofTarget(input: BoundedEvidenceInputV1, scope: ProofScope, proofNonce: string): SemanticCommandProofTargetV1 {
  const canonical = boundedRetainedJson(input.command, RETAINED_EVIDENCE_LIMITS.batchBytes).canonical;
  if (canonical !== input.canonicalOriginalBytes.toString("utf8")) refuse();
  return Object.freeze({ ...scope, proofVersion: 1, target: "semantic-command", commandId: input.command.commandId,
    idempotencyKey: input.command.idempotencyKey, intentHash: commandHash({ ...scope, proofPurpose: "retain-evidence-batch/v1", originalCommand: canonical }), proofNonce });
}

/** Only genuine same-connection, write-operation, exact-command handles pass this preparation seam. */
export function requireRetainedEvidenceAuthority(connection: SqliteConnection, handle: VerifiedRetainedEvidenceAuthority, command: RetainEvidenceBatchCommandV1): RetainedEvidenceAuthoritySnapshotV1 {
  const state = verified.get(handle);
  if (!state || state.connection !== connection || state.operation !== "retain-evidence-batch"
    || boundedRetainedJson(command, RETAINED_EVIDENCE_LIMITS.batchBytes).canonical !== state.commandCanonical) return refuse();
  return state.verifier.revalidate(handle);
}

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
export class RetainedEvidenceAuthorityVerifier {
  readonly #connection: SqliteConnection;
  readonly #capabilities: CapabilityService;
  readonly #repository = new SessionAuthorityRepository();
  constructor(options: { connection: SqliteConnection; capabilities: CapabilityService }) { this.#connection = options.connection; this.#capabilities = options.capabilities; }
  private inspect(invocation: RetainedEvidenceInvocationV1): RetainedEvidenceAuthoritySnapshotV1 {
    const { context, input } = invocation, b = context.binding;
    const a = retainedExactRecord(invocation.authorization, ["kind", "authoritySessionId", "targetSessionId", "proof", "approval", "childBindingGrant"]);
    if (a.kind !== "protected" || a.proof === null || a.approval !== null || a.childBindingGrant !== null
      || a.targetSessionId !== input.command.targetSessionId || typeof a.authoritySessionId !== "string") return refuse();
    const proof = retainedExactRecord(a.proof, ["proofVersion", "target", "proofNonce", "proofFingerprint"]);
    if (proof.proofVersion !== 1 || proof.target !== "semantic-command" || typeof proof.proofNonce !== "string"
      || typeof proof.proofFingerprint !== "string") return refuse();
    const identity = this.#connection.prepare("SELECT project_id, vault_id, store_id FROM project_meta WHERE singleton = 1").get();
    if (!identity || identity.project_id !== b.projectId || identity.vault_id !== b.vaultId || identity.store_id !== b.storeId) refuse("SESSION_OWNERSHIP_MISMATCH");
    const authorizer = this.#repository.get(this.#connection, b.projectId, a.authoritySessionId);
    const target = this.#repository.get(this.#connection, b.projectId, input.command.targetSessionId);
    if (!authorizer || !target) return refuse("SESSION_NOT_FOUND");
    current(authorizer); current(target);
    if (authorizer.workspaceId !== b.workspaceId || target.workspaceId !== b.workspaceId
      || authorizer.clientNamespace !== b.clientNamespace || target.clientNamespace !== b.clientNamespace
      || (authorizer.sessionKind === "root" ? b.actorRole !== "primary" || authorizer.rootHandleClientInstanceId !== b.clientInstanceId
        : b.actorRole !== "untrusted" || authorizer.childHandleClientInstanceId !== b.clientInstanceId || !authorizer.directAccessEnabled)) refuse("SESSION_OWNERSHIP_MISMATCH");
    if (authorizer.sessionId !== target.sessionId && (authorizer.sessionKind !== "root"
      || authorizer.parentSessionId !== null || target.sessionKind !== "child" || target.parentSessionId !== authorizer.sessionId)) refuse("SESSION_OWNERSHIP_MISMATCH");
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
    const scope: ProofScope = { projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace, authoritySessionId: authorizer.sessionId, targetSessionId: target.sessionId,
      presentingActorRole: b.actorRole, presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: b.actorRole, targetClientInstanceId: b.clientInstanceId,
      capabilityKind: material.claims.kind, capabilityGeneration: material.claims.capabilityGeneration };
    this.#capabilities.verifyProof(material, retainedEvidenceProofTarget(input, scope, proof.proofNonce), {
      proofVersion: 1, target: "semantic-command", proofNonce: proof.proofNonce, proofFingerprint: proof.proofFingerprint });
    return decodeRetainedEvidenceAuthority({ projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace, presentingActorRole: b.actorRole, presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: b.actorRole, targetClientInstanceId: b.clientInstanceId, authorizationSessionId: authorizer.sessionId,
      targetSessionId: target.sessionId, parentSessionId: target.parentSessionId, rootSessionId: root.sessionId,
      rootOwnerGeneration: root.ownerGeneration.toString(), authorizingOwnerGeneration: authorizer.ownerGeneration?.toString() ?? null,
      authorizingCapabilityGeneration: authorizer.childCapabilityGeneration?.toString() ?? null, targetOwnerGeneration: target.ownerGeneration?.toString() ?? null,
      targetCapabilityGeneration: target.childCapabilityGeneration?.toString() ?? null, capabilityKind: material.claims.kind });
  }
  verify(invocation: RetainedEvidenceInvocationV1): VerifiedRetainedEvidenceAuthority {
    const input = decodeRetainEvidenceBatch(invocation.input.command);
    try {
      if (!input.canonicalOriginalBytes.equals(invocation.input.canonicalOriginalBytes)) refuse();
      const context = boundedRetainedJson(invocation.context, RETAINED_EVIDENCE_LIMITS.batchBytes).snapshot as unknown as ProjectContext;
      const authorization = boundedRetainedJson(invocation.authorization, 16_384).snapshot as unknown as SemanticCommandAuthorization;
      const owned = Object.freeze({ context, input: Object.freeze({ command: input.command, canonicalOriginalBytes: invocation.input.canonicalOriginalBytes }), authorization });
      const snapshot = this.inspect(owned);
      const handle = Object.freeze(Object.create(null)) as VerifiedRetainedEvidenceAuthority;
      verified.set(handle, { connection: this.#connection, verifier: this, invocation: owned,
        commandCanonical: input.canonicalOriginalBytes.toString("utf8"), snapshot, operation: "retain-evidence-batch" });
      return handle;
    } finally { input.canonicalOriginalBytes.fill(0); }
  }
  revalidate(handle: VerifiedRetainedEvidenceAuthority): RetainedEvidenceAuthoritySnapshotV1 {
    const state = verified.get(handle);
    if (!state || state.connection !== this.#connection || state.verifier !== this || state.operation !== "retain-evidence-batch") return refuse();
    const currentSnapshot = this.inspect(state.invocation);
    if (canonicalJson(currentSnapshot) !== canonicalJson(state.snapshot)) refuse("SESSION_HANDLE_STALE");
    return currentSnapshot;
  }
}
