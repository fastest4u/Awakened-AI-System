import { types } from "node:util";
import type { StoredEvent } from "../contracts/event.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { responseHash } from "../crypto/event-hash.js";
import { authenticateStoredEvent } from "../integrity/stored-event-authenticator.js";
import type { GovernedNoteStoredResultV1, GovernedNoteWitnessV1, GovernedNoteStoredResultV2, GovernedNoteWitnessV2 } from "./contracts.js";
import { decodeGovernedNoteCreatedPayloadV1, decodeGovernedNoteSourcePayloadV1, decodeGovernedNoteStoredResultV1, decodeGovernedNoteCreatedPayloadV2, decodeGovernedNoteSourcePayloadV2, decodeGovernedNoteStoredResultV2 } from "./codec.js";
import { governedNoteCommandHash, governedNoteCommandHashV2 } from "./intent.js";
import { GovernedNoteError } from "./errors.js";
import type { SqliteRow } from "../storage/sqlite-driver.js";

export const noteIntegrity = (): never => { throw new GovernedNoteError("INTEGRITY_FAILURE"); };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export type GovernedNotePriorV1 = Readonly<{ witness: GovernedNoteWitnessV1; events: readonly [StoredEvent, StoredEvent]; result: GovernedNoteStoredResultV1; commandHash: string; responseHash: string }>;
export type GovernedNotePriorV2 = Readonly<{ witness: GovernedNoteWitnessV2; events: readonly [StoredEvent, StoredEvent]; result: GovernedNoteStoredResultV2; commandHash: string; responseHash: string }>;
export type GovernedNotePrior = GovernedNotePriorV1 | GovernedNotePriorV2;
export function governedNoteWitnessHash(w: GovernedNoteWitnessV1 | GovernedNoteWitnessV2): string {
  return w.witnessVersion === 2 ? governedNoteCommandHashV2(w) : governedNoteCommandHash(w);
}
/** Recognition must never execute caller accessors, including malformed reserved input. */
export function isReservedGovernedNoteSource(value: unknown): boolean {
  const field = (v: unknown, key: string): unknown => {
    if (typeof v !== "object" || v === null) return undefined;
    if (types.isProxy(v)) throw new Error();
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (d && !("value" in d)) throw new Error();
    return d?.value;
  };
  try {
    const item = field(value, "item"), marker = field(item, "verificationMethod"), key = field(item, "normalizedKey");
    const version = field(value, "sourceVersion");
    return typeof version === "number" && version >= 3 || marker === "governed-note-unverified-v1" || marker === "governed-note-unverified-v2" || typeof key === "string" && key.startsWith("governed-note/");
  } catch { return true; }
}
export function isGovernedNoteEvent(event: Pick<StoredEvent, "streamId" | "streamType" | "eventType" | "payloadJson"> & { eventSchemaVersion?: number }): boolean {
  if (event.streamType === "governed-note" || event.streamId.startsWith("governed-note/") || event.eventType === "GovernedNoteCreated") return true;
  if (event.eventType !== "MemorySourceRecorded") return false;
  try { return (event.eventSchemaVersion ?? 0) >= 4 || isReservedGovernedNoteSource(JSON.parse(event.payloadJson)); } catch { return false; }
}
export function serialGovernedNoteEvent(event: StoredEvent): unknown {
  const { payload: _cache, ...fields } = event;
  return { ...fields, globalPosition: String(event.globalPosition), streamVersion: String(event.streamVersion), lifecycleIntentJson: event.lifecycleIntentJson ?? null };
}
/** Pure single-member validation for the projection decoder; storage readers additionally require the pair. */
export function assertGovernedNoteMember(event: StoredEvent): void {
  try {
    const note = event.eventType === "GovernedNoteCreated";
    const modern = event.eventSchemaVersion === (note ? 2 : 4);
    const w = note ? (modern ? decodeGovernedNoteCreatedPayloadV2 : decodeGovernedNoteCreatedPayloadV1)(JSON.parse(event.payloadJson)).witness : null;
    const s = note ? null : (modern ? decodeGovernedNoteSourcePayloadV2 : decodeGovernedNoteSourcePayloadV1)(JSON.parse(event.payloadJson));
    const binding = w?.binding ?? s!.binding, recordId = w?.recordId ?? s!.item.itemId, recordedAt = w?.recordedAt ?? s!.item.validFrom, confidence = w?.confidence ?? s!.item.confidence;
    if (event.eventType !== (note ? "GovernedNoteCreated" : "MemorySourceRecorded") || event.eventSchemaVersion !== (note ? modern ? 2 : 1 : modern ? 4 : 3) || event.streamVersion !== (note ? 1n : 2n) || event.commandEventIndex !== (note ? 0 : 1) || event.streamType !== "governed-note" || event.streamId !== `governed-note/${binding.sessionId}/${recordId}` || event.agentId !== "governed-note" || event.correlationId !== event.commandId || event.causationId !== null || event.occurredAt !== recordedAt || event.recordedAt !== recordedAt || event.confidence !== confidence || event.visibilityScope !== "session" || event.verificationStatus !== "unverified" || event.lifecycleIntentJson != null || !same(event.evidenceRefs, []) || !same(event.evidenceDigests, [])) return noteIntegrity();
    for (const key of ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId"] as const) if (event[key] !== binding[key]) return noteIntegrity();
    for (const id of [event.eventId, event.commandId, event.idempotencyKey, ...event.sourceRefs]) if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return noteIntegrity();
    if (!same(event.sourceRefs, [...new Set(event.sourceRefs)].sort()) || event.sourceRefs.length === 0) return noteIntegrity();
    if (w && (event.eventId !== w.noteEventId || event.commandId !== w.commandId || event.idempotencyKey !== w.idempotencyKey || event.parentSessionId !== w.authority.parentSessionId || event.actorRole !== w.authority.presentingActorRole || event.clientInstanceId !== w.authority.presentingClientInstanceId || !same(event.sourceRefs, [...new Set(w.provenance.map(p => p.sourceEventId))].sort()))) return noteIntegrity();
  } catch { return noteIntegrity(); }
}
export function validateGovernedNotePair(events: readonly StoredEvent[], input: GovernedNoteStoredResultV1): GovernedNoteWitnessV1 {
  const w = validateGovernedNotePairAny(events, input);
  if (w.witnessVersion !== 1) return noteIntegrity(); return w;
}
export function validateGovernedNotePairV2(events: readonly StoredEvent[], input: GovernedNoteStoredResultV2): GovernedNoteWitnessV2 {
  const w = validateGovernedNotePairAny(events, input);
  if (w.witnessVersion !== 2) return noteIntegrity(); return w;
}
export function validateGovernedNotePairAny(events: readonly StoredEvent[], input: GovernedNoteStoredResultV1 | GovernedNoteStoredResultV2): GovernedNoteWitnessV1 | GovernedNoteWitnessV2 {
  try {
    if (events.length !== 2) return noteIntegrity();
    const [note, source] = events as readonly [StoredEvent, StoredEvent];
    authenticateStoredEvent(note, { expectedPosition: note.globalPosition, previousEventHash: note.previousGlobalHash });
    authenticateStoredEvent(source, { expectedPosition: note.globalPosition + 1n, previousEventHash: note.eventHash });
    const modern = note.eventSchemaVersion === 2;
    const w = (modern ? decodeGovernedNoteCreatedPayloadV2 : decodeGovernedNoteCreatedPayloadV1)(JSON.parse(note.payloadJson)).witness;
    const s = (modern ? decodeGovernedNoteSourcePayloadV2 : decodeGovernedNoteSourcePayloadV1)(JSON.parse(source.payloadJson));
    const result = (modern ? decodeGovernedNoteStoredResultV2 : decodeGovernedNoteStoredResultV1)(input), receipt = result.response;
    for (const event of events) assertGovernedNoteMember(event);
    if (w.witnessVersion === 2) {
      if (s.sourceVersion !== 3 || receipt.resultVersion !== 2 || s.item.recordKind !== w.recordKind || s.item.content.format !== w.contentFormat || s.item.content.contentHash !== w.bodyContentHash || receipt.content.format !== w.contentFormat || receipt.content.contentHash !== w.bodyContentHash) return noteIntegrity();
    }
    const ids = [w.noteEventId, w.sourceEventId], refs = [...new Set(w.provenance.map(p => p.sourceEventId))].sort();
    if (note.eventType !== "GovernedNoteCreated" || note.eventSchemaVersion !== (modern ? 2 : 1) || source.eventType !== "MemorySourceRecorded" || source.eventSchemaVersion !== (modern ? 4 : 3) || note.globalPosition < 1n || source.globalPosition > 9223372036854775807n) return noteIntegrity();
    for (const [index, e] of events.entries()) {
      if (e.eventId !== ids[index] || e.commandEventIndex !== index || e.streamVersion !== BigInt(index + 1) || e.commandId !== w.commandId || e.idempotencyKey !== w.idempotencyKey || e.streamType !== "governed-note" || e.streamId !== `governed-note/${w.authority.targetSessionId}/${w.recordId}` || e.sessionId !== w.authority.targetSessionId || e.parentSessionId !== w.authority.parentSessionId || e.actorRole !== w.authority.presentingActorRole || e.clientInstanceId !== w.authority.presentingClientInstanceId || e.agentId !== "governed-note" || e.correlationId !== w.commandId || e.causationId !== null || e.occurredAt !== w.recordedAt || e.recordedAt !== w.recordedAt || e.visibilityScope !== "session" || e.confidence !== w.confidence || e.verificationStatus !== "unverified" || e.lifecycleIntentJson != null || !same(e.sourceRefs, refs) || !same(e.evidenceRefs, []) || !same(e.evidenceDigests, [])) return noteIntegrity();
      for (const key of ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId"] as const) if (e[key] !== w.binding[key]) return noteIntegrity();
    }
    if (w.provenance.some(p => BigInt(p.sourceEventPosition) >= note.globalPosition) || !same(s.binding, w.binding) || s.item.itemId !== w.recordId || s.item.normalizedKey !== `governed-note/${w.recordKind}/${w.recordId}` || s.item.confidence !== w.confidence || s.item.validFrom !== w.recordedAt || s.item.contentHash !== w.summaryContentHash || !same(result.eventIds, ids) || result.firstGlobalPosition !== String(note.globalPosition) || result.lastGlobalPosition !== String(source.globalPosition) || result.finalStreamVersion !== "2" || receipt.commandId !== w.commandId || receipt.idempotencyKey !== w.idempotencyKey || receipt.recordId !== w.recordId || receipt.recordKind !== w.recordKind || !same(receipt.scope, w.binding) || !same(receipt.sourceEventIds, ids) || receipt.terminalPosition !== String(source.globalPosition)) return noteIntegrity();
    return w;
  } catch { return noteIntegrity(); }
}
const authColumns = ["lifecycle_authorization_kind", "authorization_proof_version", "authorization_proof_nonce", "authorization_proof_digest", "authorization_approval_id", "authorization_approval_digest", "authorization_session_id", "target_session_id", "presenting_actor_role", "presenting_client_instance_id", "target_actor_role", "target_client_instance_id", "internal_workflow_id", "internal_workflow_generation", "internal_planned_work_id", "internal_claim_owner_id", "internal_claim_token"] as const;
export type GovernedNoteDedupRowV1 = Readonly<{ projectId: string; commandId: string; idempotencyKey: string; commandType: string; state: string; commandHash: string; responseHash: string; responseJson: string; eventIdsJson: string; outboxOrderJson: string; firstGlobalPosition: bigint; lastGlobalPosition: bigint; finalStreamVersion: bigint; workspaceHeadCommit: string | null; committedAt: string; lifecycleAuthorization: readonly null[] }>;
export function decodeGovernedNoteDedupRowV1(row: SqliteRow): GovernedNoteDedupRowV1 {
  const text = (key: string): string => { if (typeof row[key] !== "string") return noteIntegrity(); return row[key]; };
  const integer = (key: string): bigint => { const v = row[key]; if (typeof v !== "bigint" || v < 1n || v > 9223372036854775807n) return noteIntegrity(); return v; };
  if (row.workspace_head_commit !== null && (typeof row.workspace_head_commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(row.workspace_head_commit))) return noteIntegrity();
  const lifecycleAuthorization = authColumns.map(k => { if (row[k] !== null) return noteIntegrity(); return null; });
  return Object.freeze({ projectId: text("project_id"), commandId: text("command_id"), idempotencyKey: text("idempotency_key"), commandType: text("command_type"), state: text("state"), commandHash: text("command_hash"), responseHash: text("response_hash"), responseJson: text("response_json"), eventIdsJson: text("event_ids_json"), outboxOrderJson: text("outbox_order_json"), firstGlobalPosition: integer("first_global_position"), lastGlobalPosition: integer("last_global_position"), finalStreamVersion: integer("final_stream_version"), workspaceHeadCommit: row.workspace_head_commit, committedAt: text("committed_at"), lifecycleAuthorization: Object.freeze(lifecycleAuthorization) });
}
export function assertGovernedNoteDedupCorrespondence(pair: GovernedNotePrior, row: GovernedNoteDedupRowV1): void {
  const w = validateGovernedNotePairAny(pair.events, pair.result);
  if (!same(pair.witness, w) || row.projectId !== w.authority.projectId || row.commandId !== w.commandId || row.idempotencyKey !== w.idempotencyKey || row.commandType !== "create-governed-note" || row.state !== "committed" || row.commandHash !== governedNoteWitnessHash(w) || pair.commandHash !== row.commandHash || pair.responseHash !== row.responseHash || row.responseHash !== responseHash(pair.result) || row.responseJson !== canonicalJson(pair.result) || row.eventIdsJson !== canonicalJson([w.noteEventId, w.sourceEventId]) || row.outboxOrderJson !== "[]" || row.firstGlobalPosition !== pair.events[0].globalPosition || row.lastGlobalPosition !== pair.events[1].globalPosition || row.finalStreamVersion !== 2n || row.committedAt !== w.recordedAt || row.lifecycleAuthorization.length !== authColumns.length || row.lifecycleAuthorization.some(v => v !== null)) noteIntegrity();
}
