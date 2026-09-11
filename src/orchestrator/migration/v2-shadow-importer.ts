import { createHash } from "node:crypto";
import type { AppendCommand, JsonValue } from "../contracts/event.js";
import type { ProjectContext } from "../identity/contracts.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { EventStore, EventStoreError, MAX_CANONICAL_COMMAND_BYTES, MAX_EVENTS_PER_COMMAND, type EventAppendStatements } from "../storage/event-store.js";
import { BranchScopeRepository } from "../storage/branch-scope.repository.js";
import { MaintenanceFence } from "../storage/maintenance-fence.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import { SqliteV2ShadowMigrationRepository, type ImportedRecordReceipt } from "../storage/v2-shadow-migration.repository.js";
import { deterministicMigrationUuid, ShadowMigrationError, type ShadowMigrationPolicyV1 } from "./v2-shadow-migration.contracts.js";
import type { SealedV2MigrationPackage, V2MigrationPackageRecordV1 } from "./v2-migration-package.js";

export interface V1ProjectionSourceImportedV1 { readonly schemaVersion: 1; readonly migrationIdentity: string; readonly sourceOrdinal: number; readonly sourceRecordHash: string; readonly sourceEvent: Readonly<{ globalPosition: string; eventId: string; projectId: string; vaultId: string; storeId: string; workspaceId: string; branchScopeId: string | null; branchRef: string | null; streamId: string; streamType: string; streamVersion: string; eventType: string; eventSchemaVersion: number; sessionId: string | null; parentSessionId: string | null; actorRole: string; agentId: string; clientInstanceId: string; correlationId: string; causationId: string | null; commandId: string; idempotencyKey: string; commandEventIndex: number; occurredAt: string; recordedAt: string; visibilityScope: string; confidence: string; verificationStatus: string; sourceRefs: readonly string[]; evidenceRefs: readonly []; evidenceDigests: readonly []; payloadJson: string; payloadHash: string; previousGlobalHash: string; eventHash: string; lifecycleIntentJson: string | null; }>; }
export interface V1LegacyArtifactImportedV1 { readonly schemaVersion: 1; readonly migrationIdentity: string; readonly sourceOrdinal: number; readonly sourceRecordHash: string; readonly relativePath: string; readonly contentSha256: string; readonly contentUtf8: string; }
export interface V2ShadowImportResult { readonly schemaVersion: 1; readonly migrationIdentity: string; readonly packageChecksum: string; readonly recordCount: number; readonly eventIds: readonly string[]; readonly firstImportedPosition: bigint | null; readonly terminalImportedPosition: bigint | null; readonly terminalImportedEventHash: string; readonly importedEventsChecksum: string; readonly deduplicated: boolean; }
export interface V2ShadowImportInput { readonly context: ProjectContext; readonly sealedPackage: SealedV2MigrationPackage; }
export interface V2ShadowImporterDependencies { readonly connection: SqliteConnection; readonly statements: EventAppendStatements; readonly maintenance: MaintenanceFence; readonly branchScopes: BranchScopeRepository; readonly repository: SqliteV2ShadowMigrationRepository; readonly policy: ShadowMigrationPolicyV1; readonly faultInjector?: ConstructorParameters<typeof EventStore>[6]; }

type ImportedPayload = V1ProjectionSourceImportedV1 | V1LegacyArtifactImportedV1;
type PlannedRecord = Readonly<{ ordinal: number; kind: "source-event" | "legacy-artifact"; sourceRecordHash: string; payload: ImportedPayload; eventId: string; }>;
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
    const records = this.plan(sealedPackage);
    const prior = this.dependencies.repository.transact(manifest.projectId, identity, (tx) => {
      const run = tx.readRun();
      if (run === null || run.packageChecksum !== manifest.packageChecksum || run.sourceManifestChecksum !== manifest.sourceManifestChecksum) conflict();
      return tx.readImportedRecords();
    });
    this.assertReceipts(prior, records, manifest.projectId, identity);
    const recordedOrdinals = new Set(prior.map((receipt) => receipt.sourceOrdinal));
    const batches = batchesFor(records, this.dependencies.policy, context, sealedPackage);
    const replayed = batches.every((batch) => batch.every((record) => recordedOrdinals.has(record.ordinal)));
    for (const [batchOrdinal, batch] of batches.entries()) {
      if (!batch.every((record) => recordedOrdinals.has(record.ordinal))) this.appendBatch(context, sealedPackage, batch, batchOrdinal);
    }
    const receipts = this.dependencies.repository.transact(manifest.projectId, identity, (tx) => tx.readImportedRecords());
    this.assertReceipts(receipts, records, manifest.projectId, identity);
    const ordered = [...receipts].sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
    const first = ordered[0] ?? null;
    const terminal = ordered.at(-1) ?? null;
    return Object.freeze({ schemaVersion: 1, migrationIdentity: identity, packageChecksum: manifest.packageChecksum, recordCount: records.length,
      eventIds: Object.freeze(ordered.map((receipt) => receipt.importedEventId)), firstImportedPosition: first?.importedGlobalPosition ?? null,
      terminalImportedPosition: terminal?.importedGlobalPosition ?? null, terminalImportedEventHash: terminal?.importedEventHash ?? "0".repeat(64),
      importedEventsChecksum: checksum(ordered.map((receipt) => ({ ordinal: receipt.sourceOrdinal, eventId: receipt.importedEventId, position: receipt.importedGlobalPosition.toString(), eventHash: receipt.importedEventHash }))),
      deduplicated: replayed });
  }

  private plan(package_: SealedV2MigrationPackage): readonly PlannedRecord[] {
    const records = [...package_.records()];
    if (records.length !== package_.manifest.recordDescriptors.length) sourceInvalid();
    return Object.freeze(records.map((record, index) => planRecord(record, package_.migrationIdentity, index)));
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

  private assertReceipts(receipts: readonly ImportedRecordReceipt[], records: readonly PlannedRecord[], projectId: string, identity: string): void {
    if (receipts.length > records.length) conflict();
    for (const receipt of receipts) {
      const record = records.find((candidate) => candidate.ordinal === receipt.sourceOrdinal);
      if (record === undefined || receipt.projectId !== projectId || receipt.migrationIdentity !== identity || receipt.sourceKind !== record.kind || receipt.sourceRecordHash !== record.sourceRecordHash || receipt.importedEventId !== record.eventId) conflict();
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
    return Object.freeze({ ordinal: descriptor.ordinal, kind: descriptor.kind, sourceRecordHash, eventId: deterministicMigrationUuid("event", identity, descriptor.ordinal), payload: Object.freeze({ schemaVersion: 1, migrationIdentity: identity, sourceOrdinal: descriptor.ordinal, sourceRecordHash, relativePath: descriptor.relativePath, contentSha256: descriptor.contentSha256, contentUtf8 }) });
  }
  let sourceEvent: Record<string, unknown>;
  try { sourceEvent = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>; } catch { sourceInvalid(); }
  const required = ["globalPosition","eventId","projectId","vaultId","storeId","workspaceId","branchScopeId","branchRef","streamId","streamType","streamVersion","eventType","eventSchemaVersion","sessionId","parentSessionId","actorRole","agentId","clientInstanceId","correlationId","causationId","commandId","idempotencyKey","commandEventIndex","occurredAt","recordedAt","visibilityScope","confidence","verificationStatus","sourceRefs","evidenceRefs","evidenceDigests","payloadJson","payloadHash","previousGlobalHash","eventHash","lifecycleIntentJson"];
  if (required.some((key) => !(key in sourceEvent)) || Object.keys(sourceEvent).some((key) => key !== "payload" && !required.includes(key))) sourceInvalid();
  const wrappedSource = Object.freeze(Object.fromEntries(required.map((key) => [key, sourceEvent[key]]))) as V1ProjectionSourceImportedV1["sourceEvent"];
  return Object.freeze({ ordinal: descriptor.ordinal, kind: descriptor.kind, sourceRecordHash, eventId: deterministicMigrationUuid("event", identity, descriptor.ordinal), payload: Object.freeze({ schemaVersion: 1, migrationIdentity: identity, sourceOrdinal: descriptor.ordinal, sourceRecordHash, sourceEvent: wrappedSource }) });
}

function batchesFor(records: readonly PlannedRecord[], policy: ShadowMigrationPolicyV1, context: ProjectContext, package_: SealedV2MigrationPackage): readonly (readonly PlannedRecord[])[] {
  const maxEvents = Math.min(policy.maxBatchEvents, MAX_EVENTS_PER_COMMAND); const maxBytes = Math.min(policy.maxBatchBytes, MAX_CANONICAL_COMMAND_BYTES);
  const result: PlannedRecord[][] = []; let batch: PlannedRecord[] = [];
  for (const record of records) {
    const eventBytes = Buffer.byteLength(canonicalJson(record.payload), "utf8"); if (eventBytes > policy.maxEventBytes) limit(record.ordinal);
    let candidate = [...batch, record];
    if (candidate.length > maxEvents || commandBytes(planCommand(context, package_, candidate, result.length).command) > maxBytes) {
      if (batch.length === 0) limit(record.ordinal);
      result.push(batch); batch = []; candidate = [record];
      if (commandBytes(planCommand(context, package_, candidate, result.length).command) > maxBytes) limit(record.ordinal);
    }
    batch = candidate;
  }
  if (batch.length > 0) result.push(batch); return Object.freeze(result.map((value) => Object.freeze(value)));
}

function planCommand(context: ProjectContext, package_: SealedV2MigrationPackage, batch: readonly PlannedRecord[], batchOrdinal: number): PlannedCommand {
  const identity = package_.migrationIdentity; const eventIds = Object.freeze(batch.map((record) => record.eventId));
  const sourceTime = batch.find((record) => record.kind === "source-event")?.payload as V1ProjectionSourceImportedV1 | undefined;
  const baseTime = sourceTime?.sourceEvent.recordedAt ?? "1970-01-01T00:00:00.000Z";
  const recordedAt = new Date(Date.parse(baseTime) + batchOrdinal).toISOString();
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

function readCommitted(connection: SqliteConnection, projectId: string, records: readonly PlannedRecord[], first: bigint, last: bigint, recordedAt: string): readonly ImportedRecordReceipt[] {
  const rows = connection.prepare("SELECT global_position,event_id,event_hash,payload_json FROM events WHERE project_id=$projectId AND global_position BETWEEN $first AND $last ORDER BY global_position").all({ $projectId: projectId, $first: first, $last: last });
  if (rows.length !== records.length) conflict();
  return Object.freeze(rows.map((row, index) => { const record = records[index]!; if (row.event_id !== record.eventId || typeof row.event_hash !== "string" || typeof row.payload_json !== "string") conflict(); let payload: unknown; try { payload = JSON.parse(row.payload_json); } catch { conflict(); } if (canonicalJson(payload as JsonValue) !== canonicalJson(record.payload as unknown as JsonValue)) conflict(); return Object.freeze({ projectId, migrationIdentity: (record.payload as { migrationIdentity: string }).migrationIdentity, sourceOrdinal: record.ordinal, sourceKind: record.kind, sourceRecordHash: record.sourceRecordHash, importedEventId: record.eventId, importedGlobalPosition: BigInt(row.global_position as bigint), importedEventHash: row.event_hash, recordedAt }); }));
}

function deterministicIds(ids: readonly string[]): () => string { let index = 0; return () => ids[index++] ?? deterministicMigrationUuid("event", "0".repeat(64), index); }
function checksum(value: string | Uint8Array | unknown): string { const hash = createHash("sha256"); if (typeof value === "string") hash.update(value, "utf8"); else if (value instanceof Uint8Array) hash.update(value); else hash.update(canonicalJson(value as JsonValue), "utf8"); return hash.digest("hex"); }
function sourceInvalid(): never { throw new ShadowMigrationError("MIGRATION_SOURCE_INVALID", Object.freeze({})); }
function conflict(): never { throw new ShadowMigrationError("MIGRATION_IDENTITY_CONFLICT", Object.freeze({})); }
function limit(ordinal: number): never { throw new ShadowMigrationError("MIGRATION_LIMIT_EXCEEDED", Object.freeze({ ordinal })); }
