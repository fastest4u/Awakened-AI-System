import { createHash } from "node:crypto";
import type { AppendCommand, JsonValue, StoredEvent } from "../contracts/event.js";
import { authenticateStoredEvent } from "../integrity/stored-event-authenticator.js";
import type { ProjectContext } from "../identity/contracts.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { EventStore, EventStoreError, GENESIS_GLOBAL_HASH, MAX_CANONICAL_COMMAND_BYTES, MAX_EVENTS_PER_COMMAND, type EventAppendStatements } from "../storage/event-store.js";
import { BranchScopeRepository } from "../storage/branch-scope.repository.js";
import { MaintenanceFence } from "../storage/maintenance-fence.js";
import type { SqliteConnection, SqliteRow } from "../storage/sqlite-driver.js";
import { SqliteV2ShadowMigrationRepository, type ImportedRecordReceipt } from "../storage/v2-shadow-migration.repository.js";
import { deterministicMigrationUuid, ShadowMigrationError, type ShadowMigrationPolicyV1 } from "./v2-shadow-migration.contracts.js";
import type { SealedV2MigrationPackage, V2MigrationPackageRecordV1 } from "./v2-migration-package.js";

export interface V1ProjectionSourceImportedV1 { readonly schemaVersion: 1; readonly migrationIdentity: string; readonly sourceOrdinal: number; readonly sourceRecordHash: string; readonly sourceEvent: Readonly<{ globalPosition: string; eventId: string; projectId: string; vaultId: string; storeId: string; workspaceId: string; branchScopeId: string | null; branchRef: string | null; streamId: string; streamType: string; streamVersion: string; eventType: string; eventSchemaVersion: number; sessionId: string | null; parentSessionId: string | null; actorRole: string; agentId: string; clientInstanceId: string; correlationId: string; causationId: string | null; commandId: string; idempotencyKey: string; commandEventIndex: number; occurredAt: string; recordedAt: string; visibilityScope: string; confidence: string; verificationStatus: string; sourceRefs: readonly string[]; evidenceRefs: readonly []; evidenceDigests: readonly []; payloadJson: string; payloadHash: string; previousGlobalHash: string; eventHash: string; lifecycleIntentJson: string | null; }>; }
export interface V1LegacyArtifactImportedV1 { readonly schemaVersion: 1; readonly migrationIdentity: string; readonly sourceOrdinal: number; readonly sourceRecordHash: string; readonly relativePath: string; readonly contentSha256: string; readonly contentUtf8: string; }
export interface V2ShadowImportResult { readonly schemaVersion: 1; readonly migrationIdentity: string; readonly packageChecksum: string; readonly recordCount: number; readonly eventIds: readonly string[]; readonly firstImportedPosition: bigint | null; readonly terminalImportedPosition: bigint | null; readonly terminalImportedEventHash: string; readonly importedEventsChecksum: string; readonly deduplicated: boolean; }
export interface V2ShadowImportInput { readonly context: ProjectContext; readonly sealedPackage: SealedV2MigrationPackage; }
export interface V2ShadowImporterDependencies { readonly connection: SqliteConnection; readonly statements: EventAppendStatements; readonly maintenance: MaintenanceFence; readonly branchScopes: BranchScopeRepository; readonly repository: SqliteV2ShadowMigrationRepository; readonly policy: ShadowMigrationPolicyV1; readonly faultInjector?: ConstructorParameters<typeof EventStore>[6]; }

type ImportedPayload = V1ProjectionSourceImportedV1 | V1LegacyArtifactImportedV1;
type PlannedRecord = Readonly<{ ordinal: number; kind: "source-event" | "legacy-artifact"; sourceRecordHash: string; sourceByteLength: number; payload: ImportedPayload; eventId: string; }>;
interface ImportResponse { readonly [key: string]: JsonValue; readonly schemaVersion: 1; readonly migrationIdentity: string; readonly packageChecksum: string; readonly batchOrdinal: number; readonly eventIds: string[]; }
type PlannedCommand = Readonly<{ recordedAt: string; eventIds: readonly string[]; command: AppendCommand<ImportResponse>; }>;
const HASH = /^[0-9a-f]{64}$/;

export class V2ShadowImporter {
  public constructor(private readonly dependencies: V2ShadowImporterDependencies) {}

  public import(input: V2ShadowImportInput): V2ShadowImportResult {
    const { context, sealedPackage } = input;
    const manifest = sealedPackage.manifest;
    const identity = sealedPackage.migrationIdentity;
    if (context.binding.projectId !== manifest.projectId || context.binding.vaultId !== manifest.vaultId || context.binding.storeId !== manifest.storeId || context.binding.workspaceId !== manifest.workspaceId) sourceInvalid();
    sealedPackage.assertUnchanged();
    const prior = this.dependencies.repository.transact(manifest.projectId, identity, (tx) => {
      const run = tx.readRun();
      if (run === null || run.packageChecksum !== manifest.packageChecksum || run.sourceManifestChecksum !== manifest.sourceManifestChecksum) conflict();
      return tx.readImportedRecords();
    });
    if (prior.length > manifest.recordDescriptors.length) conflict();
    const priorByOrdinal = new Map(prior.map((receipt) => [receipt.sourceOrdinal, receipt]));
    let replayed = true;
    streamBatches(sealedPackage, this.dependencies.policy, context, (batch, batchOrdinal) => {
      const receipts = batch.map((record) => priorByOrdinal.get(record.ordinal)).filter((receipt): receipt is ImportedRecordReceipt => receipt !== undefined);
      if (receipts.length !== 0 && receipts.length !== batch.length) conflict();
      if (receipts.length === batch.length) {
        const planned = planCommand(context, sealedPackage, batch, batchOrdinal);
        for (const [index, receipt] of receipts.entries()) assertReceipt(this.dependencies.connection, receipt, batch[index]!, planned.recordedAt, context.binding.projectId);
      } else { replayed = false; this.appendBatch(context, sealedPackage, batch, batchOrdinal); }
    });
    const receipts = this.dependencies.repository.transact(manifest.projectId, identity, (tx) => tx.readImportedRecords());
    if (receipts.length !== manifest.recordDescriptors.length) conflict();
    const ordered = [...receipts].sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
    const first = ordered[0] ?? null;
    const terminal = ordered.at(-1) ?? null;
    sealedPackage.assertUnchanged();
    return Object.freeze({ schemaVersion: 1, migrationIdentity: identity, packageChecksum: manifest.packageChecksum, recordCount: manifest.recordDescriptors.length,
      eventIds: Object.freeze(ordered.map((receipt) => receipt.importedEventId)), firstImportedPosition: first?.importedGlobalPosition ?? null,
      terminalImportedPosition: terminal?.importedGlobalPosition ?? null, terminalImportedEventHash: terminal?.importedEventHash ?? "0".repeat(64),
      importedEventsChecksum: checksum(ordered.map((receipt) => ({ ordinal: receipt.sourceOrdinal, eventId: receipt.importedEventId, position: receipt.importedGlobalPosition.toString(), eventHash: receipt.importedEventHash }))),
      deduplicated: replayed });
  }

  private appendBatch(context: ProjectContext, package_: SealedV2MigrationPackage, batch: readonly PlannedRecord[], batchOrdinal: number): void {
    if (batch.length === 0) return;
    const identity = package_.migrationIdentity;
    const planned = planCommand(context, package_, batch, batchOrdinal);
    const eventStore = new EventStore(this.dependencies.connection, this.dependencies.statements, this.dependencies.maintenance, this.dependencies.branchScopes,
      () => planned.recordedAt, deterministicIds(planned.eventIds), this.dependencies.faultInjector);
    try {
      const result = eventStore.append(planned.command);
      if (canonicalJson(result.response) !== canonicalJson(planned.command.publicResponse) || result.eventIds.length !== batch.length || result.eventIds.some((id, index) => id !== planned.eventIds[index])) conflict();
      const receipts = readCommitted(this.dependencies.connection, context.binding.projectId, batch, result.firstGlobalPosition, result.lastGlobalPosition, planned.recordedAt);
      this.dependencies.repository.transact(context.binding.projectId, identity, (tx) => tx.insertImportedRecords(receipts));
    } catch (error) {
      if (error instanceof ShadowMigrationError) throw error;
      if (error instanceof EventStoreError && error.code === "COMMAND_OUTCOME_UNKNOWN") throw new ShadowMigrationError("MIGRATION_OUTCOME_UNKNOWN", Object.freeze({ batchOrdinal }), { cause: error });
      if (error instanceof EventStoreError && error.code === "COMMAND_TOO_LARGE") limit(batch[0]!.ordinal);
      if (error instanceof EventStoreError) throw new ShadowMigrationError("MIGRATION_IDENTITY_CONFLICT", Object.freeze({ batchOrdinal }), { cause: error });
      throw error;
    }
  }

}

function planRecord(record: V2MigrationPackageRecordV1, identity: string, index: number): PlannedRecord {
  const descriptor = record.descriptor;
  if (descriptor.ordinal !== index || !HASH.test(descriptor.contentSha256)) sourceInvalid();
  const bytes = Buffer.concat([...record.readChunks()].map((chunk) => Buffer.from(chunk)));
  if (bytes.length !== descriptor.byteLength || checksum(bytes) !== descriptor.contentSha256) sourceInvalid();
  const sourceRecordHash = descriptor.contentSha256;
  if (descriptor.kind === "legacy-artifact") {
    let contentUtf8: string;
    try { contentUtf8 = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { sourceInvalid(); }
    if (!Buffer.from(contentUtf8, "utf8").equals(bytes) || descriptor.relativePath === null) sourceInvalid();
    return Object.freeze({ ordinal: descriptor.ordinal, kind: descriptor.kind, sourceRecordHash, sourceByteLength: descriptor.byteLength, eventId: deterministicMigrationUuid("event", identity, descriptor.ordinal), payload: Object.freeze({ schemaVersion: 1, migrationIdentity: identity, sourceOrdinal: descriptor.ordinal, sourceRecordHash, relativePath: descriptor.relativePath, contentSha256: descriptor.contentSha256, contentUtf8 }) });
  }
  let sourceEvent: Record<string, unknown>;
  try { sourceEvent = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>; } catch { sourceInvalid(); }
  const required = ["globalPosition","eventId","projectId","vaultId","storeId","workspaceId","branchScopeId","branchRef","streamId","streamType","streamVersion","eventType","eventSchemaVersion","sessionId","parentSessionId","actorRole","agentId","clientInstanceId","correlationId","causationId","commandId","idempotencyKey","commandEventIndex","occurredAt","recordedAt","visibilityScope","confidence","verificationStatus","sourceRefs","evidenceRefs","evidenceDigests","payloadJson","payloadHash","previousGlobalHash","eventHash","lifecycleIntentJson"];
  if (required.some((key) => !(key in sourceEvent)) || Object.keys(sourceEvent).some((key) => key !== "payload" && !required.includes(key))) sourceInvalid();
  const wrappedSource = Object.freeze(Object.fromEntries(required.map((key) => [key, sourceEvent[key]]))) as V1ProjectionSourceImportedV1["sourceEvent"];
  return Object.freeze({ ordinal: descriptor.ordinal, kind: descriptor.kind, sourceRecordHash, sourceByteLength: descriptor.byteLength, eventId: deterministicMigrationUuid("event", identity, descriptor.ordinal), payload: Object.freeze({ schemaVersion: 1, migrationIdentity: identity, sourceOrdinal: descriptor.ordinal, sourceRecordHash, sourceEvent: wrappedSource }) });
}

function streamBatches(package_: SealedV2MigrationPackage, policy: ShadowMigrationPolicyV1, context: ProjectContext,
  consume: (batch: readonly PlannedRecord[], batchOrdinal: number) => void): void {
  const maxEvents = Math.min(policy.maxBatchEvents, MAX_EVENTS_PER_COMMAND); const maxBytes = Math.min(policy.maxBatchBytes, MAX_CANONICAL_COMMAND_BYTES);
  let batch: PlannedRecord[] = []; let ordinal = 0; let batchOrdinal = 0;
  for (const sourceRecord of package_.records()) {
    const record = planRecord(sourceRecord, package_.migrationIdentity, ordinal);
    if (record.sourceByteLength > policy.maxEventBytes) limit(record.ordinal);
    let candidate = [...batch, record];
    if (candidate.length > maxEvents || commandBytes(planCommand(context, package_, candidate, batchOrdinal).command) > maxBytes) {
      if (batch.length === 0) limit(record.ordinal);
      consume(Object.freeze(batch), batchOrdinal++); batch = []; candidate = [record];
      if (commandBytes(planCommand(context, package_, candidate, batchOrdinal).command) > maxBytes) limit(record.ordinal);
    }
    batch = candidate; ordinal += 1;
    if (batch.length === maxEvents) { consume(Object.freeze(batch), batchOrdinal++); batch = []; }
  }
  if (ordinal !== package_.manifest.recordDescriptors.length) sourceInvalid();
  if (batch.length > 0) consume(Object.freeze(batch), batchOrdinal);
}

function planCommand(context: ProjectContext, package_: SealedV2MigrationPackage, batch: readonly PlannedRecord[], batchOrdinal: number): PlannedCommand {
  const identity = package_.migrationIdentity; const eventIds = Object.freeze(batch.map((record) => record.eventId));
  const recordedAt = new Date(Date.parse(package_.manifest.createdAt) + batchOrdinal).toISOString();
  const publicResponse: ImportResponse = { schemaVersion: 1, migrationIdentity: identity, packageChecksum: package_.manifest.packageChecksum, batchOrdinal, eventIds: [...eventIds] };
  const command: AppendCommand<ImportResponse> = { context, commandId: deterministicMigrationUuid("command", identity, batchOrdinal),
    idempotencyKey: `v2-shadow-import:${identity}:${batchOrdinal}`, commandType: "ImportV2ShadowBatch",
    correlationId: deterministicMigrationUuid("command", identity, batchOrdinal + 1_000_000), agentId: "v2-shadow-importer",
    expectedStreamVersion: BigInt(batch[0]!.ordinal), streamId: `v2-shadow-import/${identity}`, streamType: "migration",
    events: batch.map((record) => ({ eventType: record.kind === "source-event" ? "V1ProjectionSourceImported" : "V1LegacyArtifactImported",
      eventSchemaVersion: 1, occurredAt: recordedAt, visibilityScope: "project" as const, confidence: "high" as const,
      verificationStatus: "verified" as const, payload: record.payload as unknown as JsonValue,
      sourceRefs: [`migration:${identity}:${record.ordinal}`], evidenceRefs: [], evidenceDigests: [] })), outbox: [], publicResponse };
  return Object.freeze({ recordedAt, eventIds, command });
}

function commandBytes(command: AppendCommand<ImportResponse>): number {
  const events = command.events.map((event) => ({ eventType: event.eventType, eventSchemaVersion: event.eventSchemaVersion,
    occurredAt: event.occurredAt, visibilityScope: event.visibilityScope, sessionId: event.sessionId ?? null,
    parentSessionId: event.parentSessionId ?? null, causationId: event.causationId ?? null, confidence: event.confidence,
    verificationStatus: event.verificationStatus, payload: event.payload, sourceRefs: event.sourceRefs, evidenceRefs: [], evidenceDigests: [] }));
  const hashMaterial = { commandId: command.commandId, commandType: command.commandType, projectId: command.context.binding.projectId,
    storeId: command.context.binding.storeId, workspaceId: command.context.binding.workspaceId,
    git: command.context.workspace.kind === "git" ? { headCommit: command.context.workspace.headCommit,
      branchRef: command.context.workspace.branchRef, detached: command.context.workspace.detached } : null,
    streamId: command.streamId, streamType: command.streamType, expectedStreamVersion: command.expectedStreamVersion.toString(),
    correlationId: command.correlationId, agentId: command.agentId, events, outbox: [] };
  return Buffer.byteLength(canonicalJson({ ...hashMaterial, idempotencyKey: command.idempotencyKey, publicResponse: command.publicResponse }), "utf8");
}

function rowString(row: SqliteRow, key: string): string { const value = row[key]; if (typeof value !== "string") conflict(); return value; }
function rowNullableString(row: SqliteRow, key: string): string | null { const value = row[key]; if (value !== null && typeof value !== "string") conflict(); return value; }
function rowBigint(row: SqliteRow, key: string): bigint { const value = row[key]; if (typeof value !== "bigint") conflict(); return value; }
function rowJson<T>(row: SqliteRow, key: string): T { try { return JSON.parse(rowString(row, key)) as T; } catch { conflict(); } }
function storedEvent(row: SqliteRow): StoredEvent {
  return { globalPosition: rowBigint(row,"global_position"), eventId: rowString(row,"event_id"), projectId: rowString(row,"project_id") as StoredEvent["projectId"],
    vaultId: rowString(row,"vault_id") as StoredEvent["vaultId"], storeId: rowString(row,"store_id") as StoredEvent["storeId"], workspaceId: rowString(row,"workspace_id") as StoredEvent["workspaceId"],
    branchScopeId: rowNullableString(row,"branch_scope_id") as StoredEvent["branchScopeId"], branchRef: rowNullableString(row,"branch_ref"), streamId: rowString(row,"stream_id"),
    streamType: rowString(row,"stream_type"), streamVersion: rowBigint(row,"stream_version"), eventType: rowString(row,"event_type"), eventSchemaVersion: Number(rowBigint(row,"event_schema_version")),
    sessionId: rowNullableString(row,"session_id"), parentSessionId: rowNullableString(row,"parent_session_id"), actorRole: rowString(row,"actor_role") as StoredEvent["actorRole"],
    agentId: rowString(row,"agent_id"), clientInstanceId: rowString(row,"client_instance_id"), correlationId: rowString(row,"correlation_id"), causationId: rowNullableString(row,"causation_id"),
    commandId: rowString(row,"command_id"), idempotencyKey: rowString(row,"idempotency_key"), commandEventIndex: Number(rowBigint(row,"command_event_index")),
    occurredAt: rowString(row,"occurred_at"), recordedAt: rowString(row,"recorded_at"), visibilityScope: rowString(row,"visibility_scope") as StoredEvent["visibilityScope"],
    confidence: rowString(row,"confidence") as StoredEvent["confidence"], verificationStatus: rowString(row,"verification_status") as StoredEvent["verificationStatus"],
    sourceRefs: rowJson<readonly string[]>(row,"source_refs_json"), evidenceRefs: rowJson<readonly []>(row,"evidence_refs_json"), evidenceDigests: rowJson<readonly []>(row,"evidence_digests_json"),
    payload: rowJson<JsonValue>(row,"payload_json"), payloadJson: rowString(row,"payload_json"), payloadHash: rowString(row,"payload_hash"), previousGlobalHash: rowString(row,"previous_global_hash"),
    eventHash: rowString(row,"event_hash"), lifecycleIntentJson: rowNullableString(row,"lifecycle_intent_json") };
}
function authenticateDurable(connection: SqliteConnection, row: SqliteRow): StoredEvent {
  const event = storedEvent(row); let previousEventHash = GENESIS_GLOBAL_HASH;
  if (event.globalPosition > 1n) { const prior = connection.prepare("SELECT event_hash FROM events WHERE global_position=$position").get({$position:event.globalPosition-1n});
    if (prior === undefined) conflict(); previousEventHash = rowString(prior,"event_hash"); }
  try { authenticateStoredEvent(event,{expectedPosition:event.globalPosition,previousEventHash}); } catch { conflict(); }
  return event;
}
function assertDurableEvent(event: StoredEvent, record: PlannedRecord, recordedAt: string, projectId: string): void {
  const identity=(record.payload as {migrationIdentity:string}).migrationIdentity;
  if(event.projectId!==projectId||event.eventId!==record.eventId||event.recordedAt!==recordedAt||event.occurredAt!==recordedAt
    ||event.streamId!==`v2-shadow-import/${identity}`||event.streamType!=="migration"
    ||event.eventType!==(record.kind==="source-event"?"V1ProjectionSourceImported":"V1LegacyArtifactImported")
    ||canonicalJson(event.payload)!==canonicalJson(record.payload as unknown as JsonValue)
    ||canonicalJson(event.sourceRefs as unknown as JsonValue)!==canonicalJson([`migration:${identity}:${record.ordinal}`])) conflict();
}
function assertReceipt(connection: SqliteConnection, receipt: ImportedRecordReceipt, record: PlannedRecord, recordedAt: string, projectId: string): void {
  const identity=(record.payload as {migrationIdentity:string}).migrationIdentity;
  if(receipt.projectId!==projectId||receipt.migrationIdentity!==identity||receipt.sourceOrdinal!==record.ordinal||receipt.sourceKind!==record.kind
    ||receipt.sourceRecordHash!==record.sourceRecordHash||receipt.importedEventId!==record.eventId||receipt.recordedAt!==recordedAt) conflict();
  const row=connection.prepare("SELECT * FROM events WHERE project_id=$projectId AND global_position=$position").get({$projectId:projectId,$position:receipt.importedGlobalPosition});
  if(row===undefined) conflict(); const event=authenticateDurable(connection,row);
  if(event.eventId!==receipt.importedEventId||event.eventHash!==receipt.importedEventHash) conflict(); assertDurableEvent(event,record,recordedAt,projectId);
}

function readCommitted(connection: SqliteConnection, projectId: string, records: readonly PlannedRecord[], first: bigint, last: bigint, recordedAt: string): readonly ImportedRecordReceipt[] {
  const rows = connection.prepare("SELECT * FROM events WHERE project_id=$projectId AND global_position BETWEEN $first AND $last ORDER BY global_position").all({ $projectId: projectId, $first: first, $last: last });
  if (rows.length !== records.length) conflict();
  return Object.freeze(rows.map((row, index) => { const record = records[index]!; const event=authenticateDurable(connection,row); assertDurableEvent(event,record,recordedAt,projectId);
    return Object.freeze({ projectId, migrationIdentity: (record.payload as { migrationIdentity: string }).migrationIdentity, sourceOrdinal: record.ordinal, sourceKind: record.kind,
      sourceRecordHash: record.sourceRecordHash, importedEventId: record.eventId, importedGlobalPosition: event.globalPosition, importedEventHash: event.eventHash, recordedAt }); }));
}

function deterministicIds(ids: readonly string[]): () => string { let index = 0; return () => ids[index++] ?? deterministicMigrationUuid("event", "0".repeat(64), index); }
function checksum(value: string | Uint8Array | unknown): string { const hash = createHash("sha256"); if (typeof value === "string") hash.update(value, "utf8"); else if (value instanceof Uint8Array) hash.update(value); else hash.update(canonicalJson(value as JsonValue), "utf8"); return hash.digest("hex"); }
function sourceInvalid(): never { throw new ShadowMigrationError("MIGRATION_SOURCE_INVALID", Object.freeze({})); }
function conflict(): never { throw new ShadowMigrationError("MIGRATION_IDENTITY_CONFLICT", Object.freeze({})); }
function limit(ordinal: number): never { throw new ShadowMigrationError("MIGRATION_LIMIT_EXCEEDED", Object.freeze({ ordinal })); }
