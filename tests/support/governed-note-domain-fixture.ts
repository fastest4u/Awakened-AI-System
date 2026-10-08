import { randomBytes, randomUUID } from "node:crypto";
import { makeRetainedEvidenceFixture } from "./retained-evidence-fixture.js";
import { FRESH_NOW } from "./fresh-start-fixture.js";
import { CapabilityService } from "../../src/orchestrator/lifecycle/capability.service.js";
import { createCapabilityProof } from "../../src/orchestrator/lifecycle/authority/capability-codec.js";
import { SessionAuthorityRepository } from "../../src/orchestrator/storage/session-authority.repository.js";
import { GovernedNoteAuthorityVerifier, deriveGovernedNoteBinding, governedNoteCreateProofTarget, governedNoteRecoveryProofTarget, type GovernedNoteCreateProofScopeV1 } from "../../src/orchestrator/governed-notes/authority.js";
import { decodeGovernedNoteCommandV1, decodeGovernedNoteRecoveryV1 } from "../../src/orchestrator/governed-notes/codec.js";
import type { GovernedNoteCommandV1, GovernedNoteRecoveryIdsV1, PreparedGovernedNoteCreateV1, PreparedGovernedNoteRecoveryV1, GovernedNoteProvenanceDescriptorV1 } from "../../src/orchestrator/governed-notes/contracts.js";
import type { ProjectContext } from "../../src/orchestrator/identity/contracts.js";
import { EventAppendTransaction, SqliteEventAppendStatements, governedNotePlannedIds } from "../../src/orchestrator/storage/event-append-transaction.js";
import { MaintenanceFence } from "../../src/orchestrator/storage/maintenance-fence.js";
import { BranchScopeRepository } from "../../src/orchestrator/storage/branch-scope.repository.js";
import { GovernedNoteProvenanceRepository } from "../../src/orchestrator/governed-notes/provenance.repository.js";
import { buildGovernedNoteOriginalCommitment, governedNoteSummaryHash } from "../../src/orchestrator/governed-notes/intent.js";
import type { GovernedNoteCreatedPayloadV1, GovernedNoteStoredReceiptV1 } from "../../src/orchestrator/governed-notes/contracts.js";
import type { AppendCommand, JsonValue } from "../../src/orchestrator/contracts/event.js";
import { GovernedNoteService, type GovernedNoteServiceOptions } from "../../src/orchestrator/governed-notes/service.js";
import { GovernedNoteRepository } from "../../src/orchestrator/governed-notes/repository.js";

export type GovernedNoteDomainFixtureV1 = Awaited<ReturnType<typeof makeGovernedNoteDomainFixture>>;
/** Isolated direct-domain setup. This is not a same-owner native qualification. */
export async function makeGovernedNoteDomainFixture(options: Pick<Partial<GovernedNoteServiceOptions>, "faults" | "policy" | "provider"> = {}) {
  const retained = await makeRetainedEvidenceFixture();
  try {
    let nowMs = BigInt(Date.parse(FRESH_NOW));
    const clock = { now: () => new Date(Number(nowMs)).toISOString(), nowMs: () => nowMs,
      set: (value: bigint) => { nowMs = value; }, advance: (value: bigint) => { nowMs += value; } };
    const capabilities = new CapabilityService({ keyProvider: retained.lifecycle.broker, clock, nonceSource: { uuid: randomUUID, bytes: randomBytes } });
    const { connection, projectContext: rootContext, childContext, provider, policy } = retained;
    const verifier = new GovernedNoteAuthorityVerifier({ connection, capabilities, clock });
    const events = new EventAppendTransaction(connection, new SqliteEventAppendStatements(connection), new MaintenanceFence(), new BranchScopeRepository(), randomUUID,
      { hit(point) { if (point === "after-first-insert-before-commit") options.faults?.inject("after-note-event"); } });
    const sources: { root: GovernedNoteProvenanceDescriptorV1[]; child: GovernedNoteProvenanceDescriptorV1[] } = { root: [], child: [] };
    for (const [kind, authorizer, context] of [["root", retained.rootAuthority, rootContext], ["child", retained.childAuthority, childContext]] as const) {
      const invocation = retained.invocation({ version: 1, commandType: "retain-evidence-batch", commandId: randomUUID(), idempotencyKey: randomUUID(), targetSessionId: authorizer.sessionId, conversationId: randomUUID(),
        frames: [{ frameId: randomUUID(), ordinal: "0", role: "user", category: "user-message", occurredAt: FRESH_NOW, mediaType: "text/plain; charset=utf-8", content: "Owned retained attribution", previousFrameId: null, toolCorrelationId: null, artifactHashes: [] }] }, authorizer, context);
      try {
        const result = retained.service().retain(invocation);
        const row = connection.prepare("SELECT event_id, global_position, event_hash, command_id, idempotency_key FROM events WHERE event_id = $id").get({ $id: result.eventIds[0]! })!;
        const common = { sourceEventId: String(row.event_id), sourceEventPosition: String(row.global_position), sourceEventHash: String(row.event_hash), sourceCommandId: String(row.command_id), sourceIdempotencyKey: String(row.idempotency_key) };
        sources[kind].push(Object.freeze({ kind: "source-event", identity: common.sourceEventId, ...common }), Object.freeze({ kind: "retained-evidence", identity: result.response.evidenceIds[0]!, ...common }));
      } finally { invocation.input.canonicalOriginalBytes.fill(0); }
    }
    const selected = (context: ProjectContext) => context.binding.actorRole === "untrusted" ? retained.childAuthority : retained.rootAuthority;
    const scope = (context: ProjectContext): GovernedNoteCreateProofScopeV1 => {
      const b = context.binding, authorizer = selected(context), row = new SessionAuthorityRepository().get(connection, b.projectId, authorizer.sessionId)!;
      return { projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId, clientNamespace: b.clientNamespace,
        authoritySessionId: authorizer.sessionId, targetSessionId: authorizer.sessionId, presentingActorRole: b.actorRole, targetActorRole: b.actorRole,
        presentingClientInstanceId: b.clientInstanceId, targetClientInstanceId: b.clientInstanceId, capabilityKind: row.sessionKind === "root" ? "root-session-handle" : "child-session-handle", capabilityGeneration: (row.sessionKind === "root" ? row.ownerGeneration : row.childCapabilityGeneration)!.toString() };
    };
    const mint = (context: ProjectContext, target: Parameters<typeof createCapabilityProof>[1]) => {
      const authorizer = selected(context), material = capabilities.reconstructForTarget(authorizer.descriptor, authorizer.target);
      try { return createCapabilityProof(material.handle, target); }
      finally { material.handle.destroy(); if (material.kind === "root") material.resumeToken?.destroy(); }
    };
    return { connection, rootContext, childContext, capabilities, provider, clock, policy, verifier, sources, retained, scope, mint,
      service() { return new GovernedNoteService({ connection, events, repository: new GovernedNoteRepository(connection), provenance: new GovernedNoteProvenanceRepository(), authority: verifier, provider, policy: () => policy, clock, ...options }); },
      prepareNote(prepared: PreparedGovernedNoteCreateV1, context: ProjectContext = rootContext) {
        const command = prepared.command, handle = verifier.verifyCreate(prepared, context), authority = verifier.revalidateCreate(handle), binding = verifier.bindingForCreate(handle);
        const tx = new EventAppendTransaction(connection, new SqliteEventAppendStatements(connection), new MaintenanceFence(), new BranchScopeRepository());
        const plan = tx.planGovernedNoteIdentity(handle, command), ids = governedNotePlannedIds(plan);
        const provenance = new GovernedNoteProvenanceRepository().validate(connection, command.provenance, authority, binding, provider);
        const keyRef = provider.currentKey({ projectId: authority.projectId, storeId: authority.storeId }, "original-input-commitment");
        const summary = command.summary.normalize("NFC").trim();
        const witness = { witnessVersion: 1 as const, commandType: "create-governed-note" as const, commandId: command.commandId, idempotencyKey: command.idempotencyKey, ...ids, recordKind: command.recordKind, confidence: command.confidence, authority, binding, provenance, policyId: "governed-note-fixture", policyVersion: "1", originalCommitmentKeyRef: keyRef, originalInputCommitment: buildGovernedNoteOriginalCommitment(command, authority, binding, keyRef, provider), summaryContentHash: governedNoteSummaryHash(summary), recordedAt: clock.now() };
        const payload: GovernedNoteCreatedPayloadV1 = { formatVersion: 1, witness };
        const source = { sourceVersion: 2, binding: { ...binding }, item: { itemId: ids.recordId, normalizedKey: `governed-note/${command.recordKind}/${ids.recordId}`, status: "candidate", confidence: command.confidence, verificationMethod: "governed-note-unverified-v1", validFrom: clock.now(), validTo: null, summary, contentHash: witness.summaryContentHash, conflictGroupId: null, supersedingItemId: null, anchor: null }, followUps: [], artifacts: [], entities: [], aliases: [], edges: [] };
        const common = { occurredAt: clock.now(), visibilityScope: "session" as const, sessionId: authority.targetSessionId, parentSessionId: authority.parentSessionId ?? undefined, confidence: command.confidence, verificationStatus: "unverified" as const, sourceRefs: [...new Set(provenance.map(p => p.sourceEventId))].sort(), evidenceRefs: [], evidenceDigests: [] };
        const append: AppendCommand<GovernedNoteStoredReceiptV1> = { context, commandId: command.commandId, idempotencyKey: command.idempotencyKey, commandType: "create-governed-note", correlationId: command.commandId, agentId: "governed-note", streamId: `governed-note/${authority.targetSessionId}/${ids.recordId}`, streamType: "governed-note", expectedStreamVersion: 0n, events: [{ ...common, eventType: "GovernedNoteCreated", eventSchemaVersion: 1, payload: payload as unknown as JsonValue }, { ...common, eventType: "MemorySourceRecorded", eventSchemaVersion: 3, payload: source }], outbox: [], publicResponse: { resultVersion: 1, operation: "create-governed-note", commandId: command.commandId, idempotencyKey: command.idempotencyKey, recordId: ids.recordId, recordKind: command.recordKind, status: "candidate", verificationStatus: "unverified", scope: { ...binding }, sourceEventIds: [ids.noteEventId, ids.sourceEventId], terminalPosition: "1" } };
        return { tx, plan, ids, handle, append, payload, source };
      },
      /** Genuine retained-command sources, including direct child authority and conversation continuation. */
      retainSource(options: { child?: boolean; rootOnChild?: boolean; conversationId?: string; ordinal?: string; previousFrameId?: string; frames?: number } = {}) {
        const child = options.child || options.rootOnChild;
        const authorizer = options.rootOnChild ? retained.rootAuthority : child ? retained.childAuthority : retained.rootAuthority;
        let previous = options.previousFrameId ?? null;
        const frames = Array.from({ length: options.frames ?? 1 }, (_, index) => {
          const frameId = randomUUID(), frame = { frameId, ordinal: String(BigInt(options.ordinal ?? "0") + BigInt(index)), role: "user", category: "user-message", occurredAt: FRESH_NOW,
            mediaType: "text/plain; charset=utf-8", content: "Retained private input fixture_opaque", previousFrameId: previous, toolCorrelationId: null, artifactHashes: [] };
          previous = frameId; return frame;
        });
        const invocation = retained.invocation({ version: 1, commandType: "retain-evidence-batch", commandId: randomUUID(), idempotencyKey: randomUUID(),
          targetSessionId: child ? retained.childAuthority.sessionId : retained.rootAuthority.sessionId, conversationId: options.conversationId ?? randomUUID(), frames }, authorizer);
        try {
          const result = retained.service().retain(invocation);
          return { result, command: invocation.input.command, event: retained.repository.findPrior(invocation.input.command.commandId, invocation.input.command.idempotencyKey)!.event };
        } finally { invocation.input.canonicalOriginalBytes.fill(0); }
      },
      command(overrides: Partial<GovernedNoteCommandV1> = {}): GovernedNoteCommandV1 {
        return decodeGovernedNoteCommandV1({ version: 1, operation: "create-governed-note", commandId: randomUUID(), idempotencyKey: randomUUID(), recordKind: "insight", summary: " Raw e\u0301 summary ", confidence: "low", provenance: sources.root.map(({ kind, identity }) => ({ kind, identity })), ...overrides });
      },
      prepareCreate(command: GovernedNoteCommandV1, context: ProjectContext = rootContext): PreparedGovernedNoteCreateV1 {
        const s = scope(context), proof = mint(context, governedNoteCreateProofTarget(command, s, deriveGovernedNoteBinding(connection, context, s.targetSessionId), randomUUID()));
        return { command, authorization: { kind: "protected", authoritySessionId: s.authoritySessionId as never, targetSessionId: s.targetSessionId as never, proof, approval: null, childBindingGrant: null } };
      },
      prepareRecovery(ids: GovernedNoteRecoveryIdsV1, expiresAt: string, context: ProjectContext = rootContext): PreparedGovernedNoteRecoveryV1 {
        const request = decodeGovernedNoteRecoveryV1({ version: 1, operation: "recover-governed-note-result", operationId: randomUUID(), requestId: randomUUID(), commandId: ids.commandId, idempotencyKey: ids.idempotencyKey, expiresAt });
        const s = scope(context), proof = mint(context, governedNoteRecoveryProofTarget(request, context, deriveGovernedNoteBinding(connection, context, s.targetSessionId), s.capabilityGeneration, randomUUID()));
        return { request, authorization: { kind: "bounded-operation", authoritySessionId: s.authoritySessionId as never, targetSessionId: s.targetSessionId as never, proof, audience: { presentingActorRole: s.presentingActorRole, targetActorRole: s.targetActorRole, presentingClientInstanceId: s.presentingClientInstanceId, targetClientInstanceId: s.targetClientInstanceId } } };
      },
      /** All durable row contents, including authority/control tables, for nonmutation assertions. */
      rowContents(): string {
        const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
        return JSON.stringify(tables.map(row => {
          const table = String(row.name).replaceAll('"', '""');
          return [row.name, connection.prepare(`SELECT * FROM "${table}"`).all()];
        }), (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
      },
      rows(): Readonly<{ events: number; dedup: number; streams: number; outbox: number; authorization: number }> {
        const count = (table: string) => Number(connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
        return Object.freeze({ events: count("events"), dedup: count("command_dedup"), streams: count("streams"), outbox: count("outbox"), authorization: count("retained_evidence_command_authorizations") });
      }, cleanup: retained.cleanup };
  } catch (error) { await retained.cleanup(); throw error; }
}
