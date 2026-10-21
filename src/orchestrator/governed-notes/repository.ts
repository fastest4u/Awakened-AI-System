import type { StoredEvent } from "../contracts/event.js";
import type { SqliteConnection, SqliteRow } from "../storage/sqlite-driver.js";
import { GENESIS_GLOBAL_HASH } from "../storage/event-chain-constants.js";
import { authenticateStoredEvent } from "../integrity/stored-event-authenticator.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { decodeGovernedNoteStoredResultV1, decodeGovernedNoteStoredResultV2 } from "./codec.js";
import { GovernedNoteError } from "./errors.js";
import { assertGovernedNoteDedupCorrespondence, decodeGovernedNoteDedupRowV1, isGovernedNoteEvent, noteIntegrity, serialGovernedNoteEvent, validateGovernedNotePairAny, type GovernedNotePrior, type GovernedNotePriorV1 } from "./pair-validation.js";
export type { GovernedNotePriorV1, GovernedNotePriorV2, GovernedNotePrior } from "./pair-validation.js";
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
    const prior = this.findGovernedNotePriorAny(commandId, idempotencyKey);
    if (prior && prior.witness.witnessVersion !== 1) throw new GovernedNoteError("GOVERNED_NOTE_FORMAT_UNSUPPORTED");
    return prior as GovernedNotePriorV1 | null;
  }
  findGovernedNotePriorAny(commandId: string, idempotencyKey: string): GovernedNotePrior | null {
    try {
      const meta = this.connection.prepare("SELECT project_id FROM project_meta WHERE singleton=1").get(); if (!meta) return noteIntegrity();
      const projectId = text(meta, "project_id"), params = { $p: projectId, $c: commandId, $i: idempotencyKey };
      const ds = this.connection.prepare("SELECT * FROM command_dedup WHERE project_id=$p AND (command_id=$c OR idempotency_key=$i)").all(params);
      const rows = this.connection.prepare("SELECT * FROM events WHERE project_id=$p AND (command_id=$c OR idempotency_key=$i) ORDER BY global_position").all(params);
      if (ds.length === 0 && rows.length === 0) return null;
      if (ds.length === 0 || rows.length === 0) return noteIntegrity();
      const priors: GovernedNotePrior[] = [], authenticated = new Set<string>();
      for (const row of ds) {
        // Hydrate each collision using its own stored identities, not the request.
        const stored = { $p: projectId, $c: text(row, "command_id"), $i: text(row, "idempotency_key") };
        const members = this.connection.prepare("SELECT * FROM events WHERE project_id=$p AND (command_id=$c OR idempotency_key=$i) ORDER BY global_position").all(stored);
        const reserved = row.command_type === "create-governed-note" || members.some(r => isGovernedNoteEvent({ streamId: text(r, "stream_id"), streamType: text(r, "stream_type"), eventType: text(r, "event_type"), payloadJson: text(r, "payload_json"), eventSchemaVersion: Number(r.event_schema_version) }));
        if (!reserved) continue;
        if (members.length !== 2 || members.some(r => r.command_id !== stored.$c || r.idempotency_key !== stored.$i)) return noteIntegrity();
        const events = Object.freeze(members.map(hydrate)) as readonly [StoredEvent, StoredEvent];
        for (const [i, event] of events.entries()) {
          const predecessor = event.globalPosition === 1n ? null : this.connection.prepare("SELECT event_id,event_hash FROM events WHERE global_position=$pos").get({ $pos: event.globalPosition - 1n });
          if (event.globalPosition !== 1n && !predecessor || i === 1 && predecessor?.event_id !== events[0].eventId) return noteIntegrity();
          authenticateStoredEvent(event, { expectedPosition: i === 0 ? event.globalPosition : events[0].globalPosition + 1n, previousEventHash: predecessor ? text(predecessor, "event_hash") : GENESIS_GLOBAL_HASH });
          if (this.connection.prepare("SELECT 1 FROM outbox WHERE event_position=$pos LIMIT 1").get({ $pos: event.globalPosition })) return noteIntegrity();
          authenticated.add(event.eventId);
        }
        const d = decodeGovernedNoteDedupRowV1(row), parsed: unknown = JSON.parse(d.responseJson);
        // The authenticated event selects a codec which independently checks the receipt discriminator.
        const result = (events[0].eventSchemaVersion === 2 ? decodeGovernedNoteStoredResultV2 : decodeGovernedNoteStoredResultV1)(parsed);
        const prior = Object.freeze({ witness: validateGovernedNotePairAny(events, result), events, result, commandHash: d.commandHash, responseHash: d.responseHash }) as GovernedNotePrior;
        assertGovernedNoteDedupCorrespondence(prior, d); priors.push(prior);
      }
      for (const r of rows) if (!authenticated.has(text(r, "event_id")) && isGovernedNoteEvent({ streamId: text(r, "stream_id"), streamType: text(r, "stream_type"), eventType: text(r, "event_type"), payloadJson: text(r, "payload_json"), eventSchemaVersion: Number(r.event_schema_version) })) return noteIntegrity();
      if (ds.length !== 1 || priors.length !== 1 || ds[0]!.command_id !== commandId || ds[0]!.idempotency_key !== idempotencyKey) throw new GovernedNoteError("IDEMPOTENCY_CONFLICT");
      return priors[0]!;
    } catch (error) { if (error instanceof GovernedNoteError && error.code === "IDEMPOTENCY_CONFLICT") throw error; return noteIntegrity(); }
  }
}
export function assertStoredGovernedNoteCorrespondence(connection: SqliteConnection, event: StoredEvent): GovernedNotePriorV1 | null {
  const prior = assertStoredGovernedNoteCorrespondenceAny(connection, event);
  if (prior && prior.witness.witnessVersion !== 1) throw new GovernedNoteError("GOVERNED_NOTE_FORMAT_UNSUPPORTED");
  return prior as GovernedNotePriorV1 | null;
}
export function assertStoredGovernedNoteCorrespondenceAny(connection: SqliteConnection, event: StoredEvent): GovernedNotePrior | null {
  if (!isGovernedNoteEvent(event) && !connection.prepare("SELECT 1 FROM command_dedup WHERE project_id=$p AND (command_id=$c OR idempotency_key=$i) AND command_type='create-governed-note'").get({ $p: event.projectId, $c: event.commandId, $i: event.idempotencyKey })) return null;
  const prior = new GovernedNoteRepository(connection).findGovernedNotePriorAny(event.commandId, event.idempotencyKey);
  const member = prior?.events.find(e => e.eventId === event.eventId);
  if (!prior || !member || canonicalJson(serialGovernedNoteEvent(event)) !== canonicalJson(serialGovernedNoteEvent(member))) return noteIntegrity();
  return prior;
}
