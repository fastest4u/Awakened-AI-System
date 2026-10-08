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

export type GovernedNoteDomainFixtureV1 = Awaited<ReturnType<typeof makeGovernedNoteDomainFixture>>;
/** Isolated direct-domain setup. This is not a same-owner native qualification. */
export async function makeGovernedNoteDomainFixture() {
  const retained = await makeRetainedEvidenceFixture();
  try {
    let nowMs = BigInt(Date.parse(FRESH_NOW));
    const clock = { now: () => new Date(Number(nowMs)).toISOString(), nowMs: () => nowMs,
      set: (value: bigint) => { nowMs = value; }, advance: (value: bigint) => { nowMs += value; } };
    const capabilities = new CapabilityService({ keyProvider: retained.lifecycle.broker, clock, nonceSource: { uuid: randomUUID, bytes: randomBytes } });
    const { connection, projectContext: rootContext, childContext, provider, policy } = retained;
    const verifier = new GovernedNoteAuthorityVerifier({ connection, capabilities, clock });
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
      rows(): Readonly<{ events: number; dedup: number; streams: number; outbox: number; authorization: number }> {
        const count = (table: string) => Number(connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
        return Object.freeze({ events: count("events"), dedup: count("command_dedup"), streams: count("streams"), outbox: count("outbox"), authorization: count("retained_evidence_command_authorizations") });
      }, cleanup: retained.cleanup };
  } catch (error) { await retained.cleanup(); throw error; }
}
