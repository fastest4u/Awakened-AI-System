import type { StoredEvent } from "../contracts/event.js";
import type { SqliteConnection, SqliteRow } from "../storage/sqlite-driver.js";
import { GENESIS_GLOBAL_HASH } from "../storage/event-chain-constants.js";
import { authenticateStoredEvent } from "../integrity/stored-event-authenticator.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { decodeGovernedNoteStoredResultV1 } from "./codec.js";
import { GovernedNoteError } from "./errors.js";
import { assertGovernedNoteDedupCorrespondence, decodeGovernedNoteDedupRowV1, isGovernedNoteEvent, noteIntegrity, serialGovernedNoteEvent, validateGovernedNotePair, type GovernedNotePriorV1 } from "./pair-validation.js";
export type { GovernedNotePriorV1 } from "./pair-validation.js";
function text(row: SqliteRow, key: string): string { const v = row[key]; if (typeof v !== "string") return noteIntegrity(); return v; }
function hydrate(row: SqliteRow): StoredEvent {
  const event: Record<string, unknown> = {};
  for (const key of ["globalPosition", "eventId", "projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "streamId", "streamType", "streamVersion", "eventType", "eventSchemaVersion", "sessionId", "parentSessionId", "actorRole", "agentId", "clientInstanceId", "correlationId", "causationId", "commandId", "idempotencyKey", "commandEventIndex", "occurredAt", "recordedAt", "visibilityScope", "confidence", "verificationStatus", "payloadJson", "payloadHash", "previousGlobalHash", "eventHash", "lifecycleIntentJson"]) event[key] = row[key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)];
  if (typeof event.globalPosition !== "bigint" || typeof event.streamVersion !== "bigint") return noteIntegrity();
  event.eventSchemaVersion = Number(event.eventSchemaVersion); event.commandEventIndex = Number(event.commandEventIndex);
  for (const key of ["sourceRefs", "evidenceRefs", "evidenceDigests"]) {
    const json = text(row, `${key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)}_json`), parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || canonicalJson(parsed) !== json) return noteIntegrity(); event[key] = Object.freeze(parsed);
  }
  event.payload = Object.freeze({}); return Object.freeze(event) as unknown as StoredEvent;
}
export class GovernedNoteRepository {
  constructor(private readonly connection: SqliteConnection) {}
  findGovernedNotePrior(commandId: string, idempotencyKey: string): GovernedNotePriorV1 | null {
    try {
      const meta = this.connection.prepare("SELECT project_id FROM project_meta WHERE singleton=1").get(); if (!meta) return noteIntegrity();
      const params = { $p: text(meta, "project_id"), $c: commandId, $i: idempotencyKey };
      const ds = this.connection.prepare("SELECT * FROM command_dedup WHERE project_id=$p AND (command_id=$c OR idempotency_key=$i)").all(params);
      const rows = this.connection.prepare("SELECT * FROM events WHERE project_id=$p AND (command_id=$c OR idempotency_key=$i) ORDER BY global_position").all(params);
      if (ds.length === 0 && rows.length === 0) return null;
      if (ds.length === 0 || rows.length === 0) return noteIntegrity();
      if (ds.length !== 1 || ds[0]!.command_id !== commandId || ds[0]!.idempotency_key !== idempotencyKey || ds[0]!.command_type !== "create-governed-note" || rows.some(r => r.command_id !== commandId || r.idempotency_key !== idempotencyKey)) throw new GovernedNoteError("IDEMPOTENCY_CONFLICT");
      if (rows.length !== 2) return noteIntegrity();
      const events = Object.freeze(rows.map(hydrate)) as readonly [StoredEvent, StoredEvent];
      for (const [i, event] of events.entries()) {
        const predecessor = event.globalPosition === 1n ? null : this.connection.prepare("SELECT event_id,event_hash FROM events WHERE global_position=$pos").get({ $pos: event.globalPosition - 1n });
        if (event.globalPosition !== 1n && !predecessor || i === 1 && predecessor?.event_id !== events[0].eventId) return noteIntegrity();
        authenticateStoredEvent(event, { expectedPosition: i === 0 ? event.globalPosition : events[0].globalPosition + 1n, previousEventHash: predecessor ? text(predecessor, "event_hash") : GENESIS_GLOBAL_HASH });
        if (this.connection.prepare("SELECT 1 FROM outbox WHERE event_position=$pos LIMIT 1").get({ $pos: event.globalPosition })) return noteIntegrity();
      }
      const d = decodeGovernedNoteDedupRowV1(ds[0]!), result = decodeGovernedNoteStoredResultV1(JSON.parse(d.responseJson));
      const prior = Object.freeze({ witness: validateGovernedNotePair(events, result), events, result, commandHash: d.commandHash, responseHash: d.responseHash });
      assertGovernedNoteDedupCorrespondence(prior, d); return prior;
    } catch (error) { if (error instanceof GovernedNoteError) throw error; return noteIntegrity(); }
  }
}
export function assertStoredGovernedNoteCorrespondence(connection: SqliteConnection, event: StoredEvent): GovernedNotePriorV1 | null {
  if (!isGovernedNoteEvent(event) && !connection.prepare("SELECT 1 FROM command_dedup WHERE project_id=$p AND (command_id=$c OR idempotency_key=$i) AND command_type='create-governed-note'").get({ $p: event.projectId, $c: event.commandId, $i: event.idempotencyKey })) return null;
  const prior = new GovernedNoteRepository(connection).findGovernedNotePrior(event.commandId, event.idempotencyKey);
  const member = prior?.events.find(e => e.eventId === event.eventId);
  if (!prior || !member || canonicalJson(serialGovernedNoteEvent(event)) !== canonicalJson(serialGovernedNoteEvent(member))) return noteIntegrity();
  return prior;
}
