import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AppendCommand, JsonValue } from "../../src/orchestrator/contracts/event.js";
import { openImmutableProjectionImage } from "../../src/orchestrator/projections/immutable-image.js";
import { parseProjectionManifestV2, type ProjectionManifestV2 } from "../../src/orchestrator/projections/manifest-codec.js";
import type { GetCanonicalRecordRequest, NativeContentFilters, SearchProjectedContentRequest } from "../../src/orchestrator/verified-read/content-contracts.js";
import { command } from "../fixtures/fresh-start-admission-child.js";
import { FRESH_NOW } from "./fresh-start-fixture.js";
import { makeActiveReadFixture, READ_HASH, type ReadFixtureOptions } from "./v2-verified-read-fixture.js";
import { LifecycleWorkerRuntimeFactory } from "../../src/orchestrator/runtime/lifecycle-worker-runtime.factory.js";
import type { LifecycleWorkerOperationWire } from "../../src/orchestrator/runtime/lifecycle-worker-protocol.js";
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
import { decodeLifecycleSemanticCommandDraft } from "../../src/orchestrator/lifecycle/contracts/commands.js";
import { LifecycleTestKeyBroker } from "./lifecycle-test-key-broker.js";

/** Genuine authorized lifecycle setup, following project-store-lifecycle-runtime-worker.
 * No workers, host capture, guard bypass or imported parity store are used. */
function nativeLifecycleSetup(fixture: Awaited<ReturnType<typeof makeActiveReadFixture>>) {
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
      exactMaterializationTargets: [], exactCommittedTempPaths: [] }) }, childBindingFingerprint: () => null,
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
    close() { runtime.dispose(); broker.shutdown(); },
  };
}

export const NATIVE_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01";
export const NATIVE_OTHER_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02";
export const NATIVE_BRANCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03";
export const NATIVE_BRANCH_REF = "refs/heads/native-content";
export type NativeCorpus = Readonly<{
  ids: Readonly<{ canonical: string; lexical: string; artifact: string; checkpoint: string;
    openFollowUp: string; blockedFollowUp: string; superseded: string; successor: string;
    keyCollision: string; conflictMemberA: string; conflictMemberB: string }>;
  sessionIds: Readonly<{ trusted: string; other: string }>;
  conflictGroupId: string;
  sourcePositions: Readonly<Record<keyof NativeCorpus["ids"], string>>;
}>;
export type NativeContentFixture = Awaited<ReturnType<typeof makeActiveReadFixture>> & Readonly<{
  appendCorpus(): Promise<NativeCorpus>;
  captureImage(): Readonly<{ database: DatabaseSync; manifest: ProjectionManifestV2; close(): void }>;
}>;

export function nativeSearchRequest(overrides: Partial<SearchProjectedContentRequest> = {}): SearchProjectedContentRequest {
  return Object.freeze({ operation: "search-projected-content", consistency: "project-strong",
    minimumEventPosition: "0", budgetMs: 5000, parameters: Object.freeze({ query: "native", limit: 10 }), ...overrides });
}
export function nativeGetRequest(id: string, filters: NativeContentFilters = {}): GetCanonicalRecordRequest {
  return Object.freeze({ operation: "get-canonical-record", consistency: "project-strong",
    minimumEventPosition: "0", budgetMs: 5000, parameters: Object.freeze({ id, ...filters }) });
}

export async function makeNativeContentFixture(buildHash = READ_HASH, options: ReadFixtureOptions = {}): Promise<NativeContentFixture> {
  const fixture = await makeActiveReadFixture(buildHash, options);
  const versions = new Map<string, bigint>();
  const appendEvent = (eventType: string, payload: JsonValue, sessionId: string | null, eventSchemaVersion = 1) => {
    const value = command();
    const streamId = sessionId === null ? `native/${randomUUID()}` : `session/${sessionId}`;
    const expectedStreamVersion = versions.get(streamId) ?? 0n;
    const synthetic: AppendCommand<JsonValue> = { ...value, commandId: randomUUID(), correlationId: randomUUID(),
      idempotencyKey: `native/${randomUUID()}`, streamId, streamType: sessionId === null ? "memory" : "session",
      expectedStreamVersion, events: [{ ...value.events[0]!, eventType, eventSchemaVersion, ...(sessionId === null ? {} : { sessionId }),
        visibilityScope: sessionId === null ? "project" : "session", payload }] };
    const result = fixture.appendSynthetic(synthetic);
    versions.set(streamId, expectedStreamVersion + 1n);
    const eventId = fixture.writer.prepare("SELECT event_id FROM events WHERE global_position = $position")
      .get({ $position: BigInt(result.position) })!.event_id as string;
    return { ...result, eventId };
  };
  let appended = false;
  const appendCorpus = async (): Promise<NativeCorpus> => {
    if (appended) throw new Error("native corpus already appended");
    appended = true;
    const trusted = fixture.binding.session?.sessionId ?? NATIVE_SESSION;
    const lifecycle = nativeLifecycleSetup(fixture);
    try {
    const trustedDescriptor = await lifecycle.start(trusted);
    await lifecycle.start(NATIVE_OTHER_SESSION);
    versions.set(`session/${trusted}`, 1n);
    versions.set(`session/${NATIVE_OTHER_SESSION}`, 1n);
    const canonical = "abcdefab-cdef-4abc-8abc-abcdefabcdef";
    const ids: NativeCorpus["ids"] = Object.freeze({ canonical, lexical: "", artifact: randomUUID(), checkpoint: randomUUID(),
      openFollowUp: "", blockedFollowUp: "", superseded: randomUUID(), successor: randomUUID(), keyCollision: randomUUID(),
      conflictMemberA: randomUUID(), conflictMemberB: randomUUID() });
    const conflictGroupId = randomUUID();
    const positions: Partial<Record<keyof NativeCorpus["ids"], string>> = {};
    for (const [name, status, key] of [
      ["canonical", "verified", "native:exact"], ["successor", "verified", "native:successor"],
      ["superseded", "superseded", "native:superseded"], ["keyCollision", "candidate", canonical],
      ["conflictMemberA", "conflicted", "native:conflict-a"], ["conflictMemberB", "provisional", "native:conflict-b"],
    ] as const) {
      const payload = { sourceVersion: 2,
        binding: { ...fixture.binding.projectionBinding, sessionId: null }, itemId: ids[name], normalizedKey: key,
        status, confidence: "high", verificationMethod: "committed-event", validFrom: FRESH_NOW, validTo: null,
        summary: `native ${name} projected summary`, contentHash: READ_HASH,
        conflictGroupId: name.startsWith("conflictMember") ? conflictGroupId : null,
        supersedingItemId: name === "superseded" ? ids.successor : null };
      if (status === "superseded") appendEvent("MemorySourceRecorded", { ...payload, status: "verified", supersedingItemId: null }, null, 2);
      positions[name] = appendEvent("MemorySourceRecorded", payload, null, 2).position;
    }
    // A source-version-aware feedback event has real committed provenance.
    appendEvent("RetrievalFeedbackRecorded", { feedbackVersion: 1, binding: { ...fixture.binding.projectionBinding, sessionId: null },
      feedbackId: randomUUID(), itemId: canonical, outcome: "accepted", usefulness: 10000,
      sourceItemEventPosition: positions.canonical! }, null);
    const checkpoint = await lifecycle.checkpoint(trusted, trustedDescriptor, {
        checkpointVersion: 1, taskSummary: "native checkpoint lexicalneedle",
        completedItems: [], inProgressItems: [{ summary: "native open follow-up", confidence: "high" }],
        blockers: [{ summary: "native blocked follow-up", confidence: "medium" }], nextActions: [], decisions: [],
        assumptions: [], unresolvedConflicts: [], filesTouched: [],
        artifactReferences: [{ artifactId: ids.artifact, path: "src/native/artifact.ts", summary: "native artifact", contentHash: READ_HASH, confidence: "high" }],
        sourceReferences: [], commandResults: [], testResults: [], materialClaims: [],
    });
    for (const name of ["lexical", "checkpoint", "artifact", "openFollowUp", "blockedFollowUp"] as const) positions[name] = checkpoint.position;
    appendEvent("MemorySourceRecorded", { sourceVersion: 1, binding: { ...fixture.binding.projectionBinding, sessionId: NATIVE_OTHER_SESSION },
      itemId: randomUUID(), normalizedKey: "native:other-session", status: "verified", confidence: "high",
      verificationMethod: "committed-event", validFrom: FRESH_NOW, validTo: null, summary: "native foreign session", contentHash: READ_HASH }, NATIVE_OTHER_SESSION);
    return Object.freeze({ ids: Object.freeze({ ...ids, checkpoint: checkpoint.checkpointId, lexical: `${checkpoint.eventId}/task-summary`,
      openFollowUp: `${checkpoint.eventId}/follow-up/in-progress/0`, blockedFollowUp: `${checkpoint.eventId}/follow-up/blocker/0` }),
      sessionIds: Object.freeze({ trusted, other: NATIVE_OTHER_SESSION }), conflictGroupId,
      sourcePositions: Object.freeze(positions) as NativeCorpus["sourcePositions"] });
    } finally { lifecycle.close(); }
  };
  const captureImage = () => {
    const manifestPath = join(fixture.binding.projectionDirectory.canonicalPath, "projection-manifest.json");
    const manifest = parseProjectionManifestV2(JSON.parse(readFileSync(manifestPath, "utf8")), fixture.binding.projectionBinding);
    const bytes = readFileSync(join(fixture.binding.projectionDirectory.canonicalPath, manifest.databaseFile));
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.databaseSha256) throw new Error("fixture image hash mismatch");
    const database = openImmutableProjectionImage(bytes);
    return Object.freeze({ database, manifest, close: () => database.close() });
  };
  return { ...fixture, appendCorpus, captureImage };
}
