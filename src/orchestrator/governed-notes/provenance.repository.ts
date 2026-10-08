import type { SqliteConnection, SqliteRow } from "../storage/sqlite-driver.js";
import { isProjectionProjectStoreIdentity, isProjectionWorkspaceIdentity, type ProjectBinding } from "../projections/contracts.js";
import { requireEvidenceKey, type EvidenceKeyProvider } from "../privacy/evidence-key-provider.js";
import type { GovernedNoteCommandV1, GovernedNoteAuthoritySnapshotV1, GovernedNoteProvenanceDescriptorV1 } from "./contracts.js";
import { GovernedNoteError } from "./errors.js";
import type { StoredEvent } from "../contracts/event.js";
import { RetainedEvidenceRepository } from "../privacy/retained-evidence.repository.js";
import { assertRetainedStoredEvent, decodeRetainedEvidenceAuthority, verifyRetainedEvidenceTransport } from "../privacy/retained-evidence-codec.js";
import { boundedRetainedJson, retainedDataEntries, retainedExactRecord, retainedStringMetrics, RetainedEvidenceError } from "../privacy/evidence-contracts.js";
import { authenticateStoredEvent } from "../integrity/stored-event-authenticator.js";
import { assertStoredRetainedEvidenceCorrespondence } from "../integrity/event-integrity.service.js";
import { GENESIS_GLOBAL_HASH } from "../storage/event-chain-constants.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { parseCanonicalUuid } from "../lifecycle/contracts/identifiers.js";
import type { EncryptedEvidenceItemV1 } from "../privacy/evidence-envelope.js";

const integrity = (): never => { throw new GovernedNoteError("INTEGRITY_FAILURE"); };
const ineligible = (): never => { throw new GovernedNoteError("GOVERNED_NOTE_PROVENANCE_INELIGIBLE"); };
const MAX_POSITION = 9223372036854775807n;
function uuid4(value: unknown): string {
  const id = parseCanonicalUuid(value, "governed-note");
  if (id[14] !== "4") throw new Error("invalid identifier");
  return id;
}
function text(row: SqliteRow, field: string): string { if (typeof row[field] !== "string") return integrity(); return row[field]; }
function integer(row: SqliteRow, field: string, minimum: bigint): bigint {
  const value = row[field]; if (typeof value !== "bigint" || value < minimum || value > MAX_POSITION) return integrity(); return value;
}
function storedJson(row: SqliteRow, field: string): unknown {
  const value = text(row, field); retainedStringMetrics(value, 2097152, "INTEGRITY_FAILURE");
  const decoded: unknown = JSON.parse(value); if (canonicalJson(decoded) !== value) return integrity(); return decoded;
}
/** Local full persisted-row mapping. payloadJson, rather than a decoded cache, is authoritative. */
function hydrate(row: SqliteRow): StoredEvent {
  const event: Record<string, unknown> = {};
  for (const key of ["eventId", "projectId", "vaultId", "storeId", "workspaceId", "streamId", "streamType", "eventType", "actorRole", "agentId", "clientInstanceId", "correlationId", "commandId", "idempotencyKey", "occurredAt", "recordedAt", "visibilityScope", "confidence", "verificationStatus", "payloadJson", "payloadHash", "previousGlobalHash", "eventHash"]) {
    event[key] = text(row, key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`));
  }
  for (const key of ["branchScopeId", "branchRef", "sessionId", "parentSessionId", "causationId", "lifecycleIntentJson"]) {
    const value = row[key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)];
    if (value !== null && typeof value !== "string") return integrity(); event[key] = value;
  }
  event.globalPosition = integer(row, "global_position", 1n); event.streamVersion = integer(row, "stream_version", 1n);
  for (const [key, minimum] of [["eventSchemaVersion", 1n], ["commandEventIndex", 0n]] as const) {
    const value = integer(row, key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), minimum);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return integrity(); event[key] = Number(value);
  }
  for (const key of ["sourceRefs", "evidenceRefs", "evidenceDigests"]) {
    const value = storedJson(row, `${key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)}_json`);
    if (!Array.isArray(value)) return integrity(); event[key] = boundedRetainedJson(value, 2097152).snapshot;
  }
  event.payload = Object.freeze({}); return Object.freeze(event) as unknown as StoredEvent;
}
function selectors(value: unknown): GovernedNoteCommandV1["provenance"] {
  try {
    if (!Array.isArray(value)) throw new Error("invalid selectors");
    const entries = retainedDataEntries(value, 64); if (entries.length === 0) throw new Error("empty selectors");
    const seen = new Set<string>();
    const owned = entries.map(([, value]) => {
      const r = retainedExactRecord(value, ["kind", "identity"]);
      if (r.kind !== "source-event" && r.kind !== "retained-evidence") throw new Error("invalid selector kind");
      const identity = uuid4(r.identity), key = `${r.kind}/${identity}`;
      if (seen.has(key)) throw new Error("duplicate selector"); seen.add(key);
      return Object.freeze({ kind: r.kind, identity });
    });
    owned.sort((a,b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0);
    return Object.freeze(owned);
  } catch (error) {
    throw new GovernedNoteError(error instanceof RetainedEvidenceError && error.code === "RETAINED_EVIDENCE_LIMIT_EXCEEDED" ? "GOVERNED_NOTE_LIMIT_EXCEEDED" : "GOVERNED_NOTE_INPUT_INVALID");
  }
}
function currentScope(authority: GovernedNoteAuthoritySnapshotV1, binding: ProjectBinding) {
  try {
    const ownedAuthority = decodeRetainedEvidenceAuthority(authority);
    if ((ownedAuthority.capabilityKind !== "root-session-handle" && ownedAuthority.capabilityKind !== "child-session-handle")
      || ownedAuthority.authorizationSessionId !== ownedAuthority.targetSessionId
      || ownedAuthority.presentingActorRole !== ownedAuthority.targetActorRole
      || ownedAuthority.presentingClientInstanceId !== ownedAuthority.targetClientInstanceId) return ineligible();
    const ownedBinding = retainedExactRecord(binding, ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId"]);
    for (const key of ["projectId", "vaultId", "storeId"] as const) if (!isProjectionProjectStoreIdentity(ownedBinding[key]) || ownedBinding[key] !== ownedAuthority[key]) return ineligible();
    if (!isProjectionWorkspaceIdentity(ownedBinding.workspaceId) || ownedBinding.workspaceId !== ownedAuthority.workspaceId || ownedBinding.sessionId !== ownedAuthority.targetSessionId) return ineligible();
    parseCanonicalUuid(ownedBinding.sessionId, "governed-note");
    if (ownedBinding.branchScopeId !== null) parseCanonicalUuid(ownedBinding.branchScopeId, "governed-note");
    if (ownedBinding.branchRef !== null) retainedStringMetrics(ownedBinding.branchRef, 2048);
    return { authority: ownedAuthority, binding: Object.freeze({ ...ownedBinding }) };
  } catch { return ineligible(); }
}
type Parent = Readonly<{ event: StoredEvent; items: readonly EncryptedEvidenceItemV1[] }>;

/** Internal refusal; the owning note command supplies external error identities. */
export class GovernedNoteProvenanceKeyUnavailable extends Error {
  constructor() { super("GOVERNED_NOTE_PROVENANCE_KEY_UNAVAILABLE"); this.name = "GovernedNoteProvenanceKeyUnavailable"; }
}
export class GovernedNoteProvenanceRepository {
  /** Reads caller-owned transaction truth. No transaction, content or cross-call cache ownership. */
  validate(connection: SqliteConnection, references: GovernedNoteCommandV1["provenance"], currentAuthority: GovernedNoteAuthoritySnapshotV1, projectionBinding: ProjectBinding, provider: EvidenceKeyProvider): readonly GovernedNoteProvenanceDescriptorV1[] {
    const selected = selectors(references), scope = currentScope(currentAuthority, projectionBinding);
    const parents = new Map<string, Parent>(), retained = new RetainedEvidenceRepository(connection);
    try {
      const descriptors = selected.map(reference => {
        const p = scope.authority.projectId;
        const itemRow = reference.kind === "retained-evidence" ? connection.prepare("SELECT * FROM retained_evidence_blobs WHERE project_id=$p AND evidence_id=$id").get({ $p:p, $id:reference.identity }) : null;
        if (reference.kind === "retained-evidence" && !itemRow) return ineligible();
        const parentId = itemRow ? text(itemRow, "event_id") : reference.identity;
        let parent = parents.get(parentId);
        if (!parent) {
          const row = connection.prepare("SELECT * FROM events WHERE project_id=$p AND event_id=$id").get({ $p:p, $id:parentId });
          if (!row) {
            // A direct absent selector is different from surviving identified retained truth.
            if (itemRow || connection.prepare("SELECT 1 FROM retained_evidence_command_authorizations WHERE project_id=$p AND event_id=$id LIMIT 1").get({$p:p,$id:parentId})
              || connection.prepare("SELECT 1 FROM retained_evidence_blobs WHERE project_id=$p AND event_id=$id LIMIT 1").get({$p:p,$id:parentId})) return integrity();
            return ineligible();
          }
          if (row.event_type !== "EvidenceBatchRetained" || row.event_schema_version !== 1n) return ineligible();
          const event = hydrate(row), payload = assertRetainedStoredEvent(event); if (!payload) return integrity();
          uuid4(event.eventId); uuid4(event.commandId); uuid4(event.idempotencyKey);
          const predecessor = event.globalPosition === 1n ? null : connection.prepare("SELECT event_hash FROM events WHERE global_position=$pos").get({$pos:event.globalPosition - 1n});
          if (event.globalPosition > 1n && !predecessor) return integrity();
          authenticateStoredEvent(event, { expectedPosition:event.globalPosition, previousEventHash:predecessor ? text(predecessor,"event_hash") : GENESIS_GLOBAL_HASH });
          const prior = retained.findPrior(event.commandId, event.idempotencyKey); if (!prior || prior.event.eventId !== event.eventId || prior.event.eventHash !== event.eventHash || prior.event.globalPosition !== event.globalPosition) return integrity();
          assertStoredRetainedEvidenceCorrespondence(connection,event);
          if (connection.prepare("SELECT 1 FROM outbox WHERE project_id=$p AND event_position=$pos LIMIT 1").get({$p:p,$pos:event.globalPosition})) return integrity();
          const recorded = decodeRetainedEvidenceAuthority(prior.authorization);
          if ((recorded.capabilityKind !== "root-session-handle" && recorded.capabilityKind !== "child-session-handle")
            || recorded.authorizationSessionId !== recorded.targetSessionId || recorded.presentingActorRole !== recorded.targetActorRole || recorded.presentingClientInstanceId !== recorded.targetClientInstanceId
            || canonicalJson(recorded) !== canonicalJson(scope.authority)
            || canonicalJson({projectId:event.projectId,vaultId:event.vaultId,storeId:event.storeId,workspaceId:event.workspaceId,branchScopeId:event.branchScopeId,branchRef:event.branchRef,sessionId:event.sessionId}) !== canonicalJson(scope.binding)) return ineligible();
          const rows = connection.prepare("SELECT * FROM retained_evidence_blobs WHERE project_id=$p AND event_id=$id ORDER BY item_index").all({$p:p,$id:event.eventId});
          const items = Object.freeze(rows.map(row => verifyRetainedEvidenceTransport(storedJson(row,"encrypted_item_json"))));
          const keyScope = {projectId:recorded.projectId, storeId:recorded.storeId};
          try {
            for (const item of items) {
              requireEvidenceKey(provider,keyScope,"data-key-wrap",item.wrapKeyRef);
              requireEvidenceKey(provider,keyScope,"redacted-content-fingerprint",item.fingerprintKeyRef);
            }
            requireEvidenceKey(provider,keyScope,"original-input-commitment",prior.witness.originalCommitmentKeyRef);
          } catch { throw new GovernedNoteProvenanceKeyUnavailable(); }
          parent = Object.freeze({event,items}); parents.set(parentId,parent);
        }
        if (itemRow) {
          const item = verifyRetainedEvidenceTransport(storedJson(itemRow,"encrypted_item_json")), index = integer(itemRow,"item_index",0n);
          if (item.binding.evidenceId !== reference.identity || item.binding.eventId !== parent.event.eventId || itemRow.command_id !== parent.event.commandId || itemRow.idempotency_key !== parent.event.idempotencyKey
            || itemRow.event_position !== parent.event.globalPosition || index >= BigInt(parent.items.length) || canonicalJson(item) !== canonicalJson(parent.items[Number(index)])) return integrity();
        }
        const event = parent.event;
        return Object.freeze({kind:reference.kind, identity:reference.identity, sourceEventId:event.eventId, sourceEventPosition:event.globalPosition.toString(), sourceEventHash:event.eventHash, sourceCommandId:event.commandId, sourceIdempotencyKey:event.idempotencyKey});
      });
      return Object.freeze(descriptors);
    } catch (error) {
      if (error instanceof GovernedNoteProvenanceKeyUnavailable || error instanceof GovernedNoteError && error.code === "GOVERNED_NOTE_PROVENANCE_INELIGIBLE") throw error;
      return integrity();
    }
  }
}
