import type { StoredEvent } from "../contracts/event.js";
import type { SqliteConnection, SqliteRow } from "../storage/sqlite-driver.js";
import type { EncryptedEvidenceItemV1, EvidenceFrameMetadataV1 } from "./evidence-envelope.js";
import { retainedEvidenceIntentHash, type RetainedEvidenceAuthoritySnapshotV1, type RetainedEvidenceIntentWitnessV1 } from "./retained-evidence-intent.js";
import { assertRetainedEvidenceBundle, assertRetainedStoredEvent, decodeEncryptedEvidenceItem, decodeRetainedEvidenceAuthority, decodeRetainedEvidenceStoredResult, type EvidenceBatchRetainedPayloadV1, type RetainedEvidenceStoredResultV1 } from "./retained-evidence-codec.js";
import { boundedRetainedJson, RetainedEvidenceError, type BoundedEvidenceInputV1 } from "./evidence-contracts.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { responseHash } from "../crypto/event-hash.js";
import { authenticateStoredEvent } from "../integrity/stored-event-authenticator.js";
import { isPrimarySqliteBusy } from "../storage/event-append-transaction.js";

export type RetainedStreamHeadV1 = Readonly<{ targetSessionId: string; conversationId: string; lastFrameId: string; lastOrdinal: string; version: string }>;
export type RetainedEvidenceCommitV1 = Readonly<{ event: StoredEvent; items: readonly EncryptedEvidenceItemV1[]; authorization: RetainedEvidenceAuthoritySnapshotV1; expectedHead: RetainedStreamHeadV1 | null; nextHead: RetainedStreamHeadV1 }>;
export type RetainedEvidencePriorV1 = Readonly<{ authorization: RetainedEvidenceAuthoritySnapshotV1; witness: RetainedEvidenceIntentWitnessV1; event: StoredEvent; result: RetainedEvidenceStoredResultV1; commandHash: string; responseHash: string }>;
/** Trusted composition only. Exceptions propagate to the existing transaction owner. */
export type RetainedEvidenceCommitObserver = (boundary: "after-blobs" | "after-head" | "after-auth", commandId: string, idempotencyKey: string) => void;
const integrity = (): never => { throw new RetainedEvidenceError("INTEGRITY_FAILURE"); };
const order = (): never => { throw new RetainedEvidenceError("RETAINED_EVIDENCE_ORDER_CONFLICT"); };
const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);
function text(row: SqliteRow, key: string): string { const value = row[key]; if (typeof value !== "string") return integrity(); return value; }
/** Local runtime hydration; the public StoredEvent evidence type is extended by Task 4. */
function hydrate(row: SqliteRow): StoredEvent {
  const event: Record<string, unknown> = {};
  const fields = ["globalPosition", "eventId", "projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "streamId", "streamType",
    "streamVersion", "eventType", "eventSchemaVersion", "sessionId", "parentSessionId", "actorRole", "agentId", "clientInstanceId", "correlationId", "causationId",
    "commandId", "idempotencyKey", "commandEventIndex", "occurredAt", "recordedAt", "visibilityScope", "confidence", "verificationStatus", "payloadJson", "payloadHash",
    "previousGlobalHash", "eventHash", "lifecycleIntentJson"];
  for (const key of fields) event[key] = row[key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)];
  event.eventSchemaVersion = Number(event.eventSchemaVersion); event.commandEventIndex = Number(event.commandEventIndex);
  event.sourceRefs = JSON.parse(text(row, "source_refs_json")) as unknown;
  event.evidenceRefs = JSON.parse(text(row, "evidence_refs_json")) as unknown;
  event.evidenceDigests = JSON.parse(text(row, "evidence_digests_json")) as unknown;
  event.payload = Object.freeze({});
  return Object.freeze(event) as unknown as StoredEvent;
}
function serialEvent(event: StoredEvent): unknown {
  const { payload: _cache, ...persisted } = event;
  return { ...persisted, globalPosition: String(event.globalPosition), streamVersion: String(event.streamVersion),
    lifecycleIntentJson: event.lifecycleIntentJson ?? null };
}
/** Complete canonical durable bundle budget, not SQLite/WAL allocation size.
 * Trusted preparation calls this before append; the repository repeats it before blob writes. */
export function assertRetainedEvidenceCommitBundle(bundle: RetainedEvidenceCommitV1): void {
  assertRetainedEvidenceBundle(bundle.items);
  if (assertRetainedStoredEvent(bundle.event) === null) integrity();
  const authorization = decodeRetainedEvidenceAuthority(bundle.authorization);
  boundedRetainedJson({ event: serialEvent(bundle.event), items: bundle.items, authorization, nextHead: bundle.nextHead }, 2_097_152);
}
/** No connection, transaction, plaintext, key or authority ownership. */
export class RetainedEvidenceRepository {
  constructor(private readonly connection: SqliteConnection, private readonly observer?: RetainedEvidenceCommitObserver) {}
  private sql<T>(operation: () => T): T {
    try { return operation(); } catch (error) {
      if (error instanceof RetainedEvidenceError) throw error;
      if (isPrimarySqliteBusy(error)) throw new RetainedEvidenceError("SQLITE_BUSY");
      return integrity();
    }
  }
  private projectId(): string {
    const row = this.connection.prepare("SELECT project_id FROM project_meta WHERE singleton = 1").get();
    if (!row) return integrity(); return text(row, "project_id");
  }
  readHead(targetSessionId: string, conversationId: string): RetainedStreamHeadV1 | null {
    return this.sql(() => {
      const row = this.connection.prepare("SELECT * FROM retained_evidence_stream_heads WHERE project_id = $p AND target_session_id = $t AND conversation_id = $c")
        .get({ $p: this.projectId(), $t: targetSessionId, $c: conversationId });
      return row ? Object.freeze({ targetSessionId: text(row, "target_session_id"), conversationId: text(row, "conversation_id"), lastFrameId: text(row, "last_frame_id"),
        lastOrdinal: String(row.last_ordinal), version: String(row.version) }) : null;
    });
  }
  private assertFrames(targetSessionId: string, conversationId: string, commandId: string, frames: readonly EvidenceFrameMetadataV1[], head: RetainedStreamHeadV1 | null): void {
    if (frames.length === 0 || (head !== null && (head.targetSessionId !== targetSessionId || head.conversationId !== conversationId))) order();
    const inputs = new Set<string>(), projectId = this.projectId();
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      const prior = this.connection.prepare("SELECT command_id FROM retained_evidence_blobs WHERE project_id = $p AND target_session_id = $t AND conversation_id = $c AND frame_id = $f")
        .get({ $p: projectId, $t: targetSessionId, $c: conversationId, $f: frame.frameId });
      if (prior && prior.command_id !== commandId) throw new RetainedEvidenceError("RETAINED_EVIDENCE_FRAME_CONFLICT");
      if (prior) order();
    }
    const first = frames[0]!;
    if (BigInt(first.ordinal) !== (head === null ? 0n : BigInt(head.lastOrdinal) + 1n) || first.previousFrameId !== (head?.lastFrameId ?? null)) order();
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      if (i > 0 && (BigInt(frame.ordinal) !== BigInt(frames[i - 1]!.ordinal) + 1n || frame.previousFrameId !== frames[i - 1]!.frameId)) order();
      if (frame.category === "tool-input") inputs.add(frame.toolCorrelationId!);
      if (frame.category === "tool-output" && !inputs.has(frame.toolCorrelationId!)) {
        const accepted = this.connection.prepare(`SELECT 1 FROM retained_evidence_blobs b
          JOIN retained_evidence_command_authorizations a ON a.project_id = b.project_id AND a.command_id = b.command_id
          JOIN command_dedup d ON d.project_id = a.project_id AND d.command_id = a.command_id AND d.idempotency_key = a.idempotency_key
          WHERE b.project_id = $p AND b.target_session_id = $t AND b.conversation_id = $c AND b.ordinal < $o
          AND json_extract(b.encrypted_item_json, '$.frame.category') = 'tool-input'
          AND json_extract(b.encrypted_item_json, '$.frame.toolCorrelationId') = $cor LIMIT 1`)
          .get({ $p: projectId, $t: targetSessionId, $c: conversationId, $o: BigInt(frame.ordinal), $cor: frame.toolCorrelationId });
        if (!accepted) order();
      }
    }
  }
  assertCanContinue(input: BoundedEvidenceInputV1, head: RetainedStreamHeadV1 | null): void {
    this.sql(() => this.assertFrames(input.command.targetSessionId, input.command.conversationId, input.command.commandId,
      input.command.frames.map(({ content: _content, ...frame }) => ({ ...frame, artifactHashes: [...frame.artifactHashes] })), head));
  }
  insertCommitted(bundle: RetainedEvidenceCommitV1): void {
    const event = bundle.event;
    const admitted = this.sql(() => {
      assertRetainedEvidenceCommitBundle(bundle);
      const payload = assertRetainedStoredEvent(event); if (!payload) return integrity();
      const authorization = decodeRetainedEvidenceAuthority(bundle.authorization);
      if (event.projectId !== this.projectId() || !same(authorization, payload.witness.authority) || bundle.items.length !== payload.items.length) integrity();
      const storedRow = this.connection.prepare("SELECT * FROM events WHERE project_id = $p AND event_id = $e").get({ $p: this.projectId(), $e: event.eventId });
      if (!storedRow || !same(serialEvent(hydrate(storedRow)), serialEvent(event))) integrity();
      const currentHead = this.readHead(payload.witness.targetSessionId, payload.witness.conversationId);
      if (!same(currentHead, bundle.expectedHead)) order();
      this.assertFrames(payload.witness.targetSessionId, payload.witness.conversationId, event.commandId, payload.witness.frames, currentHead);
      const last = payload.witness.frames.at(-1)!;
      if (!same(bundle.nextHead, { targetSessionId: payload.witness.targetSessionId, conversationId: payload.witness.conversationId,
        lastFrameId: last.frameId, lastOrdinal: last.ordinal, version: currentHead === null ? "1" : String(BigInt(currentHead.version) + 1n) })) order();
      const items = bundle.items.map(decodeEncryptedEvidenceItem);
      for (let i = 0; i < items.length; i++) {
        const { formatVersion: _v, algorithm: _a, nonce: _n, tag: _t, ciphertext: _c, wrappedKey: _k, ...metadata } = items[i]!;
        if (!same(metadata, payload.items[i])) integrity();
      }
      return { authorization, payload, items };
    });
    this.sql(() => {
      for (let i = 0; i < admitted.items.length; i++) {
        const item = admitted.items[i]!, b = item.binding;
        this.connection.prepare(`INSERT INTO retained_evidence_blobs(project_id,vault_id,store_id,evidence_id,event_id,event_position,command_id,idempotency_key,item_index,target_session_id,conversation_id,frame_id,ordinal,encrypted_item_json)
          VALUES($p,$v,$s,$id,$e,$pos,$cmd,$idem,$i,$t,$c,$f,$o,$json)`).run({ $p: b.projectId, $v: b.vaultId, $s: b.storeId, $id: b.evidenceId, $e: b.eventId,
            $pos: event.globalPosition, $cmd: event.commandId, $idem: event.idempotencyKey, $i: i, $t: b.targetSessionId, $c: b.conversationId, $f: b.frameId,
            $o: BigInt(item.frame.ordinal), $json: canonicalJson(item) });
      }
    });
    this.observer?.("after-blobs", event.commandId, event.idempotencyKey);
    this.sql(() => {
      const next = bundle.nextHead, params = { $p: this.projectId(), $t: next.targetSessionId, $c: next.conversationId, $f: next.lastFrameId, $o: BigInt(next.lastOrdinal), $v: BigInt(next.version) };
      if (bundle.expectedHead === null) this.connection.prepare("INSERT INTO retained_evidence_stream_heads(project_id,target_session_id,conversation_id,last_frame_id,last_ordinal,version) VALUES($p,$t,$c,$f,$o,$v)").run(params);
      else {
        const changes = this.connection.prepare(`UPDATE retained_evidence_stream_heads SET last_frame_id=$f,last_ordinal=$o,version=$v
          WHERE project_id=$p AND target_session_id=$t AND conversation_id=$c AND last_frame_id=$oldF AND last_ordinal=$oldO AND version=$oldV`)
          .run({ ...params, $oldF: bundle.expectedHead.lastFrameId, $oldO: BigInt(bundle.expectedHead.lastOrdinal), $oldV: BigInt(bundle.expectedHead.version) }).changes;
        if (changes !== 1n) order();
      }
    });
    this.observer?.("after-head", event.commandId, event.idempotencyKey);
    this.sql(() => this.connection.prepare(`INSERT INTO retained_evidence_command_authorizations(project_id,command_id,idempotency_key,event_id,event_position,authorization_json)
      VALUES($p,$c,$i,$e,$pos,$a)`).run({ $p: event.projectId, $c: event.commandId, $i: event.idempotencyKey, $e: event.eventId, $pos: event.globalPosition, $a: canonicalJson(admitted.authorization) }));
    this.observer?.("after-auth", event.commandId, event.idempotencyKey);
  }
  private checkRows(event: StoredEvent, payload: EvidenceBatchRetainedPayloadV1): void {
    const rows = this.connection.prepare("SELECT * FROM retained_evidence_blobs WHERE project_id=$p AND event_id=$e ORDER BY item_index").all({ $p: event.projectId, $e: event.eventId });
    if (rows.length !== payload.items.length) integrity();
    const items = rows.map((row, i) => {
      const item = decodeEncryptedEvidenceItem(JSON.parse(text(row, "encrypted_item_json")) as unknown);
      if (row.event_position !== event.globalPosition || row.command_id !== event.commandId || row.idempotency_key !== event.idempotencyKey || row.item_index !== BigInt(i)) integrity();
      const b = item.binding;
      if (row.project_id !== b.projectId || row.vault_id !== b.vaultId || row.store_id !== b.storeId || row.evidence_id !== b.evidenceId || row.event_id !== b.eventId
        || row.target_session_id !== b.targetSessionId || row.conversation_id !== b.conversationId || row.frame_id !== b.frameId || row.ordinal !== BigInt(item.frame.ordinal)
        || text(row, "encrypted_item_json") !== canonicalJson(item)) integrity();
      const { formatVersion: _v, algorithm: _a, nonce: _n, tag: _t, ciphertext: _c, wrappedKey: _k, ...metadata } = item;
      if (!same(metadata, payload.items[i])) integrity(); return item;
    });
    assertRetainedEvidenceBundle(items);
  }
  findPrior(commandId: string, idempotencyKey: string): RetainedEvidencePriorV1 | null {
    return this.sql(() => {
      const projectId = this.projectId();
      const dedups = this.connection.prepare("SELECT * FROM command_dedup WHERE project_id=$p AND (command_id=$c OR idempotency_key=$i)").all({ $p: projectId, $c: commandId, $i: idempotencyKey });
      if (dedups.length === 0) {
        if (this.connection.prepare("SELECT 1 FROM retained_evidence_command_authorizations WHERE project_id=$p AND (command_id=$c OR idempotency_key=$i)").get({ $p: projectId, $c: commandId, $i: idempotencyKey })) integrity();
        return null;
      }
      const d = dedups[0]!;
      if (dedups.length !== 1 || d.command_id !== commandId || d.idempotency_key !== idempotencyKey || d.command_type !== "retain-evidence-batch") throw new RetainedEvidenceError("IDEMPOTENCY_CONFLICT");
      const a = this.connection.prepare("SELECT * FROM retained_evidence_command_authorizations WHERE project_id=$p AND command_id=$c AND idempotency_key=$i").get({ $p: projectId, $c: commandId, $i: idempotencyKey });
      if (!a) return integrity();
      const row = this.connection.prepare("SELECT * FROM events WHERE project_id=$p AND event_id=$e AND global_position=$pos").get({ $p: projectId, $e: text(a, "event_id"), $pos: a.event_position! });
      if (!row) return integrity();
      const event = hydrate(row), payload = assertRetainedStoredEvent(event); if (!payload) return integrity();
      const predecessor = this.connection.prepare("SELECT event_hash FROM events WHERE global_position=$pos").get({ $pos: event.globalPosition - 1n });
      authenticateStoredEvent(event, { expectedPosition: event.globalPosition, previousEventHash: predecessor ? text(predecessor, "event_hash") : "0".repeat(64) });
      const authorization = decodeRetainedEvidenceAuthority(JSON.parse(text(a, "authorization_json")) as unknown);
      const result = decodeRetainedEvidenceStoredResult(JSON.parse(text(d, "response_json")) as unknown);
      const w = payload.witness, receipt = result.response;
      if (!same(authorization, w.authority) || canonicalJson(authorization) !== a.authorization_json || w.commandId !== commandId || w.idempotencyKey !== idempotencyKey
        || event.commandId !== commandId || event.idempotencyKey !== idempotencyKey || d.first_global_position !== event.globalPosition || d.last_global_position !== event.globalPosition
        || d.final_stream_version !== event.streamVersion || text(d, "event_ids_json") !== canonicalJson([event.eventId]) || result.eventIds[0] !== event.eventId
        || result.firstGlobalPosition !== String(event.globalPosition) || result.finalStreamVersion !== String(event.streamVersion)
        || receipt.commandId !== commandId || receipt.idempotencyKey !== idempotencyKey || receipt.targetSessionId !== w.targetSessionId || receipt.conversationId !== w.conversationId
        || !same(receipt.evidenceIds, payload.items.map(i => i.binding.evidenceId)) || text(d, "response_json") !== canonicalJson(result)
        || d.command_hash !== retainedEvidenceIntentHash(w) || d.response_hash !== responseHash(result)) integrity();
      this.checkRows(event, payload);
      return Object.freeze({ authorization, witness: w, event, result, commandHash: text(d, "command_hash"), responseHash: text(d, "response_hash") });
    });
  }
  assertCorrespondence(event: StoredEvent): void {
    this.sql(() => {
      const payload = assertRetainedStoredEvent(event); if (!payload || event.projectId !== this.projectId()) integrity();
      const prior = this.findPrior(event.commandId, event.idempotencyKey);
      if (!prior || !same(serialEvent(prior.event), serialEvent(event))) integrity();
    });
  }
}
