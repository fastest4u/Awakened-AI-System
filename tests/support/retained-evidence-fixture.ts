import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "../../src/orchestrator/contracts/event.js";
import type { ProjectContext } from "../../src/orchestrator/identity/contracts.js";
import { computeProjectContextFingerprint } from "../../src/orchestrator/identity/project-binding.service.js";
import type { SqliteConnection } from "../../src/orchestrator/storage/sqlite-driver.js";
import { NodeSqliteDriver } from "../../src/orchestrator/storage/node-sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./current-project-store-schema.js";
import { activateFreshTestStore, FRESH_IDENTITY, FRESH_NOW } from "./fresh-start-fixture.js";
import { context as fixtureProjectContext } from "../fixtures/fresh-start-admission-child.js";
import { LifecycleWorkerRuntimeFactory } from "../../src/orchestrator/runtime/lifecycle-worker-runtime.factory.js";
import { decodeLifecycleWorkerOperationWire, type LifecycleWorkerOperationWire } from "../../src/orchestrator/runtime/lifecycle-worker-protocol.js";
import { SessionAuthorityRepository } from "../../src/orchestrator/storage/session-authority.repository.js";
import { SessionLeaseRepository } from "../../src/orchestrator/storage/session-lease.repository.js";
import { LifecycleApprovalRepository } from "../../src/orchestrator/storage/lifecycle-approval.repository.js";
import { ChildTransferRepository } from "../../src/orchestrator/storage/child-transfer.repository.js";
import { EvidenceCoverageRepository } from "../../src/orchestrator/storage/evidence-coverage.repository.js";
import { SqliteLifecycleProjectionRepository } from "../../src/orchestrator/storage/lifecycle-projection.repository.js";
import { MaintenanceFence } from "../../src/orchestrator/storage/maintenance-fence.js";
import { connectionBoundEvidenceCoverage } from "../../src/orchestrator/lifecycle/lifecycle-command.store.js";
import { buildLifecycleIntentWitness } from "../../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import { CapabilityService, type AuthorityMaterialDescriptorV1 } from "../../src/orchestrator/lifecycle/capability.service.js";
import { createCapabilityProof } from "../../src/orchestrator/lifecycle/authority/capability-codec.js";
import { CHILD_BINDING_GRANT_DOMAIN } from "../../src/orchestrator/lifecycle/authority/authority-material-adapter.js";
import { decodeLifecycleSemanticCommandDraft } from "../../src/orchestrator/lifecycle/contracts/commands.js";
import { LifecycleTestKeyBroker } from "./lifecycle-test-key-broker.js";
import type { EvidenceKeyProvider, EvidenceKeyPurpose, EvidenceKeyRefV1, EvidenceKeyScope, WrappedEvidenceKeyV1 } from "../../src/orchestrator/privacy/evidence-key-provider.js";
import type { RetainedEvidenceAuthoritySnapshotV1 } from "../../src/orchestrator/privacy/retained-evidence-intent.js";
import type { TrustedRedactionPolicyV1 } from "../../src/orchestrator/privacy/redaction.js";
import { canonicalJson } from "../../src/orchestrator/serialization/canonical-json.js";
import { RetainedEvidenceRepository } from "../../src/orchestrator/privacy/retained-evidence.repository.js";
import { RetainedEvidenceService, type RetainedEvidenceFaultInjector, type RetainedEvidenceServiceOptions } from "../../src/orchestrator/privacy/retained-evidence.service.js";
import { RetainedEvidenceAuthorityVerifier, retainedEvidenceProofTarget, type RetainedEvidenceInvocationV1 } from "../../src/orchestrator/privacy/retained-evidence-authority.js";
import { decodeRetainEvidenceBatch } from "../../src/orchestrator/privacy/evidence-contracts.js";
import { EventAppendTransaction, SqliteEventAppendStatements } from "../../src/orchestrator/storage/event-append-transaction.js";
import { BranchScopeRepository } from "../../src/orchestrator/storage/branch-scope.repository.js";

const READ_HASH = "a".repeat(64);
type FixtureCore = { writer: SqliteConnection; root: string; projectContext: ProjectContext; binding: { projectionBinding: { branchRef: null } } };

/** Test-only scoped provider; independent random purpose keys never leave memory. */
export class SyntheticEvidenceProvider implements EvidenceKeyProvider {
  private readonly keys = new Map<EvidenceKeyPurpose, Buffer>();
  private readonly states = new Map<EvidenceKeyPurpose, "available" | "revoked" | "unavailable">();
  constructor(private readonly scope: EvidenceKeyScope) {
    for (const p of ["data-key-wrap", "original-input-commitment", "redacted-content-fingerprint"] as const) this.keys.set(p, randomBytes(32));
  }
  currentKey(scope: EvidenceKeyScope, purpose: EvidenceKeyPurpose): EvidenceKeyRefV1 {
    const ref = Object.freeze({ keyId: `synthetic/${purpose}`, version: "1" });
    if (this.status(scope, purpose, ref) !== "available") throw new Error("synthetic key unavailable");
    return ref;
  }
  status(scope: EvidenceKeyScope, purpose: EvidenceKeyPurpose, ref: EvidenceKeyRefV1): "available" | "revoked" | "unavailable" {
    if (scope.projectId !== this.scope.projectId || scope.storeId !== this.scope.storeId || ref.keyId !== `synthetic/${purpose}` || ref.version !== "1" || !this.keys.has(purpose)) return "unavailable";
    return this.states.get(purpose) ?? "available";
  }
  setStatus(purpose: EvidenceKeyPurpose, status: "available" | "revoked" | "unavailable"): void { this.states.set(purpose, status); }
  private key(scope: EvidenceKeyScope, purpose: EvidenceKeyPurpose, ref: EvidenceKeyRefV1): Buffer {
    if (this.status(scope, purpose, ref) !== "available") throw new Error("synthetic key unavailable");
    return this.keys.get(purpose)!;
  }
  wrap(scope: EvidenceKeyScope, ref: EvidenceKeyRefV1, key: Uint8Array, aad: Uint8Array): WrappedEvidenceKeyV1 {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key(scope, "data-key-wrap", ref), nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    return { formatVersion: 1, keyRef: { ...ref }, algorithm: "AES-256-GCM", nonce: nonce.toString("base64url"),
      ciphertext: Buffer.concat([cipher.update(key), cipher.final()]).toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
  }
  unwrap(scope: EvidenceKeyScope, wrapped: WrappedEvidenceKeyV1, aad: Uint8Array): Uint8Array {
    const cipher = createDecipheriv("aes-256-gcm", this.key(scope, "data-key-wrap", wrapped.keyRef), Buffer.from(wrapped.nonce, "base64url"), { authTagLength: 16 });
    cipher.setAAD(aad); cipher.setAuthTag(Buffer.from(wrapped.tag, "base64url"));
    const first = cipher.update(Buffer.from(wrapped.ciphertext, "base64url"));
    try { return Buffer.concat([first, cipher.final()]); } finally { first.fill(0); }
  }
  mac(scope: EvidenceKeyScope, purpose: "original-input-commitment" | "redacted-content-fingerprint", ref: EvidenceKeyRefV1, domain: string, bytes: Uint8Array): Uint8Array {
    return createHmac("sha256", this.key(scope, purpose, ref)).update(domain).update("\n").update(bytes).digest();
  }
  close(): void { for (const key of this.keys.values()) key.fill(0); this.keys.clear(); }
}
function retainedLifecycleSetup(fixture: FixtureCore, childContext: ProjectContext) {
  const context = fixture.projectContext;
  const broker = new LifecycleTestKeyBroker({ seed: `native-query/${randomUUID()}` });
  const clock = { now: () => FRESH_NOW, nowMs: () => BigInt(Date.parse(FRESH_NOW)) };
  let nextSessionId: string | undefined;
  const ids = { uuid: () => { const value = nextSessionId; nextSessionId = undefined; return value ?? randomUUID(); },
    bytes: (length: number) => randomBytes(length) };
  const sourceState = () => ({ sourceStateScopeVersion: 1 as const, workspaceId: context.binding.workspaceId,
    branchRef: fixture.binding.projectionBinding.branchRef,
    headCommit: context.workspace.kind === "git" ? context.workspace.headCommit : null, dirtyWorktreeFingerprint: READ_HASH });
  const runtime = new LifecycleWorkerRuntimeFactory({ clock, identitySource: ids,
    integrity: { assertQuickHealthy: () => undefined }, resumeSourceState: { captureCurrent: sourceState },
    checkpointSourceStateProvider: { capture: async () => sourceState(), captureForCheckpoint: sourceState, captureForFinalization: sourceState },
    checkpointSourceStateScopeResolver: { resolve: () => ({ scopeVersion: 1, descriptorPath: context.binding.descriptorPath,
      storeRoot: context.binding.storeRoute.storeRoot, privateStateRoot: fixture.root,
      exactMaterializationTargets: [], exactCommittedTempPaths: [] }) }, childBindingFingerprint: target => target.actorRole === "untrusted" && target.clientInstanceId === childContext.binding.clientInstanceId ? childContext.binding.contextFingerprint : null,
    repositories: { authority: () => new SessionAuthorityRepository(), leases: () => new SessionLeaseRepository(),
      approvals: () => new LifecycleApprovalRepository(), transfers: () => new ChildTransferRepository(),
      coverage: provider => new EvidenceCoverageRepository(provider), projection: connection => new SqliteLifecycleProjectionRepository(connection) },
    transactionFacades: {
      command: ({ connection, authority, leases, approvals, transfers, coverage }) => ({
        authority: {
          get: (projectId: string, sessionId: string) => authority.get(connection, projectId, sessionId),
          insertRoot: (input: unknown) => authority.insertRoot(connection, input as never),
          insertChild: (input: unknown) => authority.insertChild(connection, input as never),
          compareAndSwap: (input: unknown) => authority.compareAndSwap(connection, input as never),
          listSafeResumeCandidates: (input: unknown) => authority.listSafeResumeCandidates(connection, input as never),
          listNonterminalRootContinuityOwners: (input: unknown) => authority.listNonterminalRootContinuityOwners(connection, input as never),
          listNonterminalChildren: (projectId: string, rootSessionId: string) => authority.listNonterminalChildren(connection, projectId, rootSessionId),
          listNonterminalChildEndingScopeProjectionsBounded: (projectId: string, rootSessionId: string, limit: number) =>
            authority.listNonterminalChildEndingScopeProjectionsBounded(connection, projectId, rootSessionId, limit),
          rootContinuityKey: (value: unknown) => authority.rootContinuityKey(connection, value as never),
          latestCheckpoint: (value: unknown) => authority.latestCheckpoint(connection, value as never),
          nextGlobalPosition: () => authority.nextGlobalPosition(connection),
          loadEvents: (value: unknown) => authority.loadEvents(connection, value as never),
          requireFoldMatch: (value: unknown) => authority.requireFoldMatch(connection, value as never),
          markCheckpointRequired: (input: unknown) => authority.markCheckpointRequired(connection, input as never),
          updateCheckpointIndex: (input: unknown) => authority.updateCheckpointIndex(connection, input as never),
          clearCheckpointRequired: (input: unknown) => authority.clearCheckpointRequired(connection, input as never),
        },
        leases: { current: (projectId: string, sessionId: string) => leases.current(connection, projectId, sessionId),
          isExpired: (value: unknown, now: bigint) => leases.isExpired(value as never, now),
          insertGeneration: (input: unknown) => leases.insertGeneration(connection, input as never),
          renewCurrent: (input: unknown) => leases.renewCurrent(connection, input as never),
          releaseCurrent: (input: unknown) => leases.releaseCurrent(connection, input as never) },
        approvals: { consume: (input: unknown) => approvals.consume(connection, input as never) },
        transfers: { get: (projectId: string, ticketId: string) => transfers.get(connection, projectId, ticketId),
          findCreatedEventPosition: (projectId: string, ticketId: string) => transfers.findCreatedEventPosition(connection, projectId, ticketId),
          listUnclaimedEndingScopeProjectionsBySourceRoot: (projectId: string, rootSessionId: string, limit: number) =>
            transfers.listUnclaimedEndingScopeProjectionsBySourceRoot(connection, projectId, rootSessionId, limit),
          insert: (input: unknown) => transfers.insert(connection, input as never), claim: (input: unknown) => transfers.claim(connection, input as never) },
        coverage: connectionBoundEvidenceCoverage(connection, coverage), workflows: {}, validation: {}, outbox: {},
      }), operational: () => ({ workflows: {}, outbox: {} } as never),
    },
  }).create({ connection: fixture.writer, maintenanceFence: new MaintenanceFence(), keyProvider: broker });
  const capabilities = new CapabilityService({ keyProvider: broker, clock, nonceSource: ids });
  const common = { projectId: context.binding.projectId, vaultId: context.binding.vaultId, storeId: context.binding.storeId,
    workspaceId: context.binding.workspaceId, clientNamespace: context.binding.clientNamespace,
    presentingActorRole: "primary" as const, presentingClientInstanceId: context.binding.clientInstanceId,
    targetActorRole: "primary" as const, targetClientInstanceId: context.binding.clientInstanceId,
    internalWorkflowId: null, internalWorkflowGeneration: null, internalPlannedWorkId: null };
  const execute = (operation: LifecycleWorkerOperationWire) => runtime.execute(operation, context);
  return {
    async start(sessionId: string) {
      const cmd = decodeLifecycleSemanticCommandDraft({ commandType: "root-start", commandId: randomUUID(),
        idempotencyKey: `native-start/${sessionId}`, agentId: "fixture-agent", expectedProjectId: common.projectId,
        expectedVaultId: common.vaultId, expectedWorkspaceId: common.workspaceId, expectedBranchRef: fixture.binding.projectionBinding.branchRef,
        continuityKey: `native/${sessionId}`, resumePolicy: "new" });
      const witness = buildLifecycleIntentWitness(cmd, { ...common, authorizationKind: "initial-authority", authorizationSessionId: null,
        targetSessionId: cmd.commandId, capabilityKind: null, capabilityGeneration: null });
      nextSessionId = sessionId;
      const result = await execute({ kind: "semantic", operation: "root-start", prepared: { command: cmd, candidateIntentHash: witness.intentHash,
        authorization: { kind: "initial-authority", authoritySessionId: null, targetSessionId: null, proof: null, approval: null, childBindingGrant: null } } } as LifecycleWorkerOperationWire);
      const started = result.result as unknown as { publicResult: { sessionId: string }; authorityMaterial: { descriptor: AuthorityMaterialDescriptorV1 } };
      if (started.publicResult.sessionId !== sessionId) throw new Error("synthetic session identity mismatch");
      return started.authorityMaterial.descriptor;
    },
    async checkpoint(sessionId: string, descriptor: AuthorityMaterialDescriptorV1, draft: JsonValue) {
      const tail = fixture.writer.prepare("SELECT MAX(global_position) AS position FROM events").get()!.position as bigint;
      const stream = fixture.writer.prepare("SELECT current_version FROM streams WHERE stream_id = $id").get({ $id: `session/${sessionId}` })!.current_version as bigint;
      const cmd = decodeLifecycleSemanticCommandDraft({ commandType: "record-checkpoint", commandId: randomUUID(),
        idempotencyKey: `native-checkpoint/${randomUUID()}`, agentId: "fixture-agent", expectedProjectId: common.projectId,
        expectedVaultId: common.vaultId, expectedWorkspaceId: common.workspaceId, expectedBranchRef: fixture.binding.projectionBinding.branchRef,
        sessionId, expectedStreamVersion: stream.toString(), expectedBaseEventPosition: tail.toString(), draft });
      const witness = buildLifecycleIntentWitness(cmd, { ...common, authorizationKind: "protected", authorizationSessionId: sessionId,
        targetSessionId: sessionId, capabilityKind: "root-session-handle", capabilityGeneration: "1" });
      const material = capabilities.reconstructForTarget(descriptor, { actorRole: "primary", clientInstanceId: context.binding.clientInstanceId });
      try {
        const { internalWorkflowId: _workflow, internalWorkflowGeneration: _generation, internalPlannedWorkId: _plan, ...proofScope } = common;
        const proof = createCapabilityProof(material.handle, { ...proofScope, proofVersion: 1, target: "semantic-command",
          authoritySessionId: sessionId, targetSessionId: sessionId, capabilityKind: "root-session-handle", capabilityGeneration: "1",
          commandId: cmd.commandId, idempotencyKey: cmd.idempotencyKey, intentHash: witness.intentHash, proofNonce: randomUUID() });
        await execute({ kind: "semantic", operation: "record-checkpoint", prepared: { command: cmd, candidateIntentHash: witness.intentHash,
          authorization: { kind: "protected", authoritySessionId: sessionId, targetSessionId: sessionId, proof, approval: null, childBindingGrant: null } } } as LifecycleWorkerOperationWire);
        const row = fixture.writer.prepare("SELECT global_position, event_id FROM events WHERE command_id = $id").get({ $id: cmd.commandId })!;
        return { position: (row.global_position as bigint).toString(), eventId: row.event_id as string,
          checkpointId: new SessionAuthorityRepository().get(fixture.writer, common.projectId, sessionId)!.latestCheckpointId! };
      } finally { material.handle.destroy(); if (material.kind === "root") material.resumeToken?.destroy(); }
    },
    broker, capabilities,
    execute,
    executeForContext: (operation: LifecycleWorkerOperationWire, context: ProjectContext) => runtime.execute(operation, context),
    async forkChild(sessionId: string, descriptor: AuthorityMaterialDescriptorV1, directAccessRequested = true) {
      const record = new SessionAuthorityRepository().get(fixture.writer, common.projectId, sessionId)!;
      const version = fixture.writer.prepare("SELECT current_version FROM streams WHERE stream_id = $id").get({ $id: `session/${sessionId}` })!.current_version as bigint;
      const cmd = decodeLifecycleSemanticCommandDraft({ commandType: "fork-child", commandId: randomUUID(), idempotencyKey: `retained-child/${randomUUID()}`,
        agentId: "fixture-agent", expectedProjectId: common.projectId, expectedVaultId: common.vaultId, expectedWorkspaceId: common.workspaceId,
        expectedBranchRef: null, parentSessionId: sessionId, expectedStreamVersion: version.toString(),
        assignment: { assignmentId: randomUUID(), summary: "Owned synthetic child", scope: "retained-fixture" }, directAccessRequested });
      const target = directAccessRequested ? { actorRole: "untrusted" as const, clientInstanceId: childContext.binding.clientInstanceId }
        : { actorRole: "primary" as const, clientInstanceId: context.binding.clientInstanceId };
      const witness = buildLifecycleIntentWitness(cmd, { ...common, targetActorRole: target.actorRole, targetClientInstanceId: target.clientInstanceId,
        authorizationKind: "protected", authorizationSessionId: sessionId, targetSessionId: sessionId,
        capabilityKind: "root-session-handle", capabilityGeneration: record.ownerGeneration!.toString() });
      const claims = { grantVersion: 1 as const, grantId: randomUUID(), projectId: common.projectId, storeId: common.storeId,
        parentSessionId: sessionId, targetActorRole: target.actorRole, targetClientInstanceId: target.clientInstanceId,
        issuedAt: FRESH_NOW, expiresAt: new Date(Date.parse(FRESH_NOW) + 60_000).toISOString(), bindingFingerprint: childContext.binding.contextFingerprint };
      const bytes = Buffer.from(canonicalJson(claims));
      let mac: Uint8Array | undefined;
      const material = capabilities.reconstructForTarget(descriptor, { actorRole: "primary", clientInstanceId: common.presentingClientInstanceId });
      try {
        const keyId = broker.currentKey({ projectId: common.projectId, storeId: common.storeId }, "child-binding-grant").keyId;
        mac = broker.mac({ projectId: common.projectId, storeId: common.storeId, purpose: "child-binding-grant", keyId, domain: CHILD_BINDING_GRANT_DOMAIN, bytes });
        const { internalWorkflowId: _w, internalWorkflowGeneration: _g, internalPlannedWorkId: _p, ...proofScope } = common;
        const proof = createCapabilityProof(material.handle, { ...proofScope, targetActorRole: target.actorRole, targetClientInstanceId: target.clientInstanceId,
          proofVersion: 1, target: "semantic-command", authoritySessionId: sessionId, targetSessionId: sessionId,
          capabilityKind: "root-session-handle", capabilityGeneration: record.ownerGeneration!.toString(),
          commandId: cmd.commandId, idempotencyKey: cmd.idempotencyKey, intentHash: witness.intentHash, proofNonce: randomUUID() });
        const result = await execute(decodeLifecycleWorkerOperationWire({ kind: "semantic", operation: "fork-child", prepared: { command: cmd, candidateIntentHash: witness.intentHash,
          authorization: { kind: "protected", authoritySessionId: sessionId, targetSessionId: sessionId, proof, approval: null,
            childBindingGrant: directAccessRequested ? { ...claims, mac: Buffer.from(mac).toString("base64url") } : null } } }));
        const committed = result.result as unknown as { publicResult: { childSessionId: string }; authorityMaterial: { descriptor: AuthorityMaterialDescriptorV1 } };
        return { sessionId: committed.publicResult.childSessionId, descriptor: committed.authorityMaterial.descriptor, target };
      } finally { bytes.fill(0); mac?.fill(0); material.handle.destroy(); if (material.kind === "root") material.resumeToken?.destroy(); }
    },
    close() { runtime.dispose(); broker.shutdown(); },
  };
}

export type RetainedEvidenceFixture = Awaited<ReturnType<typeof makeRetainedEvidenceFixture>>;
/** Real migration/control-plane/root/child setup in an identity-checked disposable directory. */
export async function makeRetainedEvidenceFixture(options: { readonly faults?: RetainedEvidenceFaultInjector } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "retained-evidence-")));
  const identity = lstatSync(root, { bigint: true });
  const path = join(root, "events.sqlite"), driver = new NodeSqliteDriver({ DatabaseSync });
  let live: SqliteConnection | undefined = driver.open(path, { mode: "create", busyTimeoutMs: 1000 });
  const connection: SqliteConnection = { exec: sql => live!.exec(sql), prepare: sql => live!.prepare(sql), close: () => { const old = live; live = undefined; old?.close(); } };
  let lifecycle: ReturnType<typeof retainedLifecycleSetup> | undefined;
  const provider = new SyntheticEvidenceProvider({ projectId: FRESH_IDENTITY.projectId, storeId: FRESH_IDENTITY.storeId });
  const cleanup = () => {
    lifecycle?.close(); provider.close(); connection.close();
    const current = lstatSync(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || realpathSync.native(root) !== root || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("owned fixture root changed");
    rmSync(root, { recursive: true, force: true });
  };
  try {
    applyCurrentProjectStoreSchema(connection, FRESH_IDENTITY, FRESH_NOW);
    const admission = await activateFreshTestStore(connection);
    const projectContext = fixtureProjectContext(root, path);
    const childContext: ProjectContext = { ...projectContext, binding: { ...projectContext.binding, actorRole: "untrusted", clientInstanceId: "retained-child-client" } };
    childContext.binding.contextFingerprint = computeProjectContextFingerprint(childContext.binding);
    lifecycle = retainedLifecycleSetup({ writer: connection, root, projectContext, binding: { projectionBinding: { branchRef: null } } }, childContext);
    const sessionId = randomUUID(), descriptor = await lifecycle.start(sessionId);
    const rootAuthority = { sessionId, descriptor, target: { actorRole: "primary" as const, clientInstanceId: projectContext.binding.clientInstanceId } };
    const childAuthority = await lifecycle.forkChild(sessionId, descriptor);
    const authorityRepository = new SessionAuthorityRepository();
    const authoritySnapshot = (targetSessionId: string = sessionId, authorizingSessionId: string = sessionId): RetainedEvidenceAuthoritySnapshotV1 => {
      const target = authorityRepository.get(connection, FRESH_IDENTITY.projectId, targetSessionId)!;
      const authorizer = authorityRepository.get(connection, FRESH_IDENTITY.projectId, authorizingSessionId)!;
      const rootRecord = authorityRepository.get(connection, FRESH_IDENTITY.projectId, sessionId)!;
      return { ...FRESH_IDENTITY, workspaceId: projectContext.binding.workspaceId, clientNamespace: projectContext.binding.clientNamespace,
        presentingActorRole: authorizingSessionId === sessionId ? "primary" : "untrusted",
        presentingClientInstanceId: authorizingSessionId === sessionId ? rootAuthority.target.clientInstanceId : childAuthority.target.clientInstanceId,
        targetActorRole: authorizingSessionId === sessionId ? "primary" : "untrusted",
        targetClientInstanceId: authorizingSessionId === sessionId ? rootAuthority.target.clientInstanceId : childAuthority.target.clientInstanceId,
        authorizationSessionId: authorizingSessionId, targetSessionId, parentSessionId: target.parentSessionId,
        rootSessionId: sessionId, rootOwnerGeneration: rootRecord.ownerGeneration!.toString(),
        authorizingOwnerGeneration: authorizer.ownerGeneration?.toString() ?? null, authorizingCapabilityGeneration: authorizer.childCapabilityGeneration?.toString() ?? null,
        targetOwnerGeneration: target.ownerGeneration?.toString() ?? null, targetCapabilityGeneration: target.childCapabilityGeneration?.toString() ?? null,
        capabilityKind: authorizingSessionId === sessionId ? "root-session-handle" : "child-session-handle" };
    };
    const policy: TrustedRedactionPolicyV1 = Object.freeze({ policyId: "retained-synthetic-policy", policyVersion: "1",
      rules: Object.freeze([Object.freeze({ kind: "token" as const, ruleId: "synthetic-token", prefix: "fixture_" })]) });
    const rows = () => Object.fromEntries(["events", "command_dedup", "retained_evidence_blobs", "retained_evidence_stream_heads", "retained_evidence_command_authorizations"].map(table => [table, connection.prepare(`SELECT * FROM ${table}`).all()]));
    const repository = new RetainedEvidenceRepository(connection, (boundary, commandId, idempotencyKey) => options.faults?.hit(boundary, commandId, idempotencyKey));
    const events = new EventAppendTransaction(connection, new SqliteEventAppendStatements(connection), new MaintenanceFence(), new BranchScopeRepository());
    const retainedAuthority = new RetainedEvidenceAuthorityVerifier({ connection, capabilities: lifecycle.capabilities });
    const service = (overrides: Partial<RetainedEvidenceServiceOptions> = {}) => new RetainedEvidenceService({ connection, events, repository,
      authority: retainedAuthority, provider, policy: () => policy, now: () => FRESH_NOW, faults: options.faults, ...overrides });
    const invocation = (value: unknown, authorizer: { sessionId: string; descriptor: AuthorityMaterialDescriptorV1; target: { actorRole: "primary" | "untrusted"; clientInstanceId: string } } = rootAuthority,
      context: ProjectContext = authorizer.target.actorRole === "primary" ? projectContext : childContext): RetainedEvidenceInvocationV1 => {
      const input = decodeRetainEvidenceBatch(value), b = context.binding;
      const record = authorityRepository.get(connection, b.projectId, authorizer.sessionId)!;
      const material = lifecycle!.capabilities.reconstructForTarget(authorizer.descriptor, authorizer.target);
      try {
        const scope = { projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId, clientNamespace: b.clientNamespace,
          authoritySessionId: authorizer.sessionId, targetSessionId: input.command.targetSessionId, presentingActorRole: b.actorRole,
          presentingClientInstanceId: b.clientInstanceId, targetActorRole: b.actorRole, targetClientInstanceId: b.clientInstanceId,
          capabilityKind: record.sessionKind === "root" ? "root-session-handle" as const : "child-session-handle" as const,
          capabilityGeneration: (record.sessionKind === "root" ? record.ownerGeneration : record.childCapabilityGeneration)!.toString() };
        const proof = createCapabilityProof(material.handle, retainedEvidenceProofTarget(input, scope, randomUUID()));
        return { context, input, authorization: { kind: "protected", authoritySessionId: authorizer.sessionId as never,
          targetSessionId: input.command.targetSessionId as never, proof, approval: null, childBindingGrant: null } };
      } catch (error) { input.canonicalOriginalBytes.fill(0); throw error; }
      finally { material.handle.destroy(); if (material.kind === "root") material.resumeToken?.destroy(); }
    };
    const protectedLifecycle = async (draft: unknown, targetSessionId: string, authorizer = rootAuthority as { sessionId: string; descriptor: AuthorityMaterialDescriptorV1; target: { actorRole: "primary" | "untrusted"; clientInstanceId: string } }) => {
      const context = authorizer.target.actorRole === "primary" ? projectContext : childContext, b = context.binding;
      const command = decodeLifecycleSemanticCommandDraft(draft);
      const record = authorityRepository.get(connection, b.projectId, authorizer.sessionId)!;
      const scope = { projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId, clientNamespace: b.clientNamespace,
        authoritySessionId: authorizer.sessionId, targetSessionId, presentingActorRole: b.actorRole, presentingClientInstanceId: b.clientInstanceId,
        targetActorRole: b.actorRole, targetClientInstanceId: b.clientInstanceId, capabilityKind: record.sessionKind === "root" ? "root-session-handle" as const : "child-session-handle" as const,
        capabilityGeneration: (record.sessionKind === "root" ? record.ownerGeneration : record.childCapabilityGeneration)!.toString() };
      const { authoritySessionId: _authorityId, ...assertionScope } = scope;
      const witness = buildLifecycleIntentWitness(command, { ...assertionScope, authorizationKind: "protected", authorizationSessionId: scope.authoritySessionId,
        internalWorkflowId: null, internalWorkflowGeneration: null, internalPlannedWorkId: null });
      const material = lifecycle!.capabilities.reconstructForTarget(authorizer.descriptor, authorizer.target);
      try {
        const proof = createCapabilityProof(material.handle, { ...scope, proofVersion: 1, target: "semantic-command", commandId: command.commandId,
          idempotencyKey: command.idempotencyKey, intentHash: witness.intentHash, proofNonce: randomUUID() });
        return await lifecycle!.executeForContext(decodeLifecycleWorkerOperationWire({ kind: "semantic", operation: command.commandType, prepared: { command,
          candidateIntentHash: witness.intentHash, authorization: { kind: "protected", authoritySessionId: authorizer.sessionId, targetSessionId, proof, approval: null, childBindingGrant: null } } }), context);
      } finally { material.handle.destroy(); if (material.kind === "root") material.resumeToken?.destroy(); }
    };
    return { root, path, connection, projectContext, childContext, provider, policy, rootAuthority, childAuthority, authoritySnapshot,
      lifecycle, admission, repository, events, retainedAuthority, service, invocation, protectedLifecycle, rows, cleanup,
      // Stable connection facade retains its genuine admission; capability/provider objects and historical key status stay alive.
      reopen() { connection.close(); live = driver.open(path, { mode: "existing", busyTimeoutMs: 1000 }); },
    };
  } catch (error) { try { cleanup(); } catch { /* preserve original setup failure */ } throw error; }
}
