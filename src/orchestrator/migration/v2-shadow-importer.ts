import { createHash } from "node:crypto";
import type { AppendCommand, JsonValue, StoredEvent } from "../contracts/event.js";
import { payloadHash } from "../crypto/event-hash.js";
import { authenticateStoredEvent } from "../integrity/stored-event-authenticator.js";
import type { ProjectContext } from "../identity/contracts.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { EventStore, EventStoreError, GENESIS_GLOBAL_HASH, MAX_CANONICAL_COMMAND_BYTES, MAX_EVENTS_PER_COMMAND,
  SqliteEventStoreStatements, type EventAppendStatements } from "../storage/event-store.js";
import { EventAppendTransaction } from "../storage/event-append-transaction.js";
import { BranchScopeRepository } from "../storage/branch-scope.repository.js";
import { MaintenanceFence } from "../storage/maintenance-fence.js";
import type { SqliteConnection, SqliteRow } from "../storage/sqlite-driver.js";
import { assertBoundSqliteConnectionIdentity } from "../storage/node-sqlite-driver.js";
import { SqliteV2ShadowMigrationRepository, type CompatibilityOutboxRecord, type ImportedRecordReceipt } from "../storage/v2-shadow-migration.repository.js";
import { captureCompatibilityPath } from "../materialization/stable-compatibility-directory.js";
import { deterministicMigrationUuid, ShadowMigrationError, shadowMigrationConfigurationChecksum,
  shadowMigrationPolicyChecksum, type ShadowMigrationPolicyV1 } from "./v2-shadow-migration.contracts.js";
import type { SealedV2MigrationPackage, V2MigrationPackageRecordV1 } from "./v2-migration-package.js";
import type { ShadowMigrationInvocationDeadline, ShadowMigrationReconciliation } from "./v2-shadow-migration-runtime.js";

export interface V1ProjectionSourceImportedV1 { readonly schemaVersion: 1; readonly migrationIdentity: string; readonly sourceOrdinal: number; readonly sourceRecordHash: string; readonly sourceEvent: Readonly<{ globalPosition: string; eventId: string; projectId: string; vaultId: string; storeId: string; workspaceId: string; branchScopeId: string | null; branchRef: string | null; streamId: string; streamType: string; streamVersion: string; eventType: string; eventSchemaVersion: number; sessionId: string | null; parentSessionId: string | null; actorRole: string; agentId: string; clientInstanceId: string; correlationId: string; causationId: string | null; commandId: string; idempotencyKey: string; commandEventIndex: number; occurredAt: string; recordedAt: string; visibilityScope: string; confidence: string; verificationStatus: string; sourceRefs: readonly string[]; evidenceRefs: readonly []; evidenceDigests: readonly []; payloadJson: string; payloadHash: string; previousGlobalHash: string; eventHash: string; lifecycleIntentJson: string | null; }>; }
export interface V1LegacyArtifactImportedV1 { readonly schemaVersion: 1; readonly migrationIdentity: string; readonly sourceOrdinal: number; readonly sourceRecordHash: string; readonly relativePath: string; readonly contentSha256: string; readonly contentUtf8: string; }
export interface V2ShadowImportResult { readonly schemaVersion: 1; readonly migrationIdentity: string; readonly packageChecksum: string; readonly recordCount: number; readonly eventIds: readonly string[]; readonly firstImportedPosition: bigint | null; readonly terminalImportedPosition: bigint | null; readonly terminalImportedEventHash: string; readonly importedEventsChecksum: string; readonly deduplicated: boolean; }
export interface V2ShadowImportInput { readonly context: ProjectContext; readonly sealedPackage: SealedV2MigrationPackage;
  readonly invocationDeadline?: ShadowMigrationInvocationDeadline; }
export interface V2ShadowImporterDependencies { readonly connection: SqliteConnection; readonly statements: EventAppendStatements; readonly maintenance: MaintenanceFence; readonly branchScopes: BranchScopeRepository; readonly policy: ShadowMigrationPolicyV1; readonly eventStorePath?: string; readonly faultInjector?: ConstructorParameters<typeof EventStore>[6]; }

type ImportedPayload = V1ProjectionSourceImportedV1 | V1LegacyArtifactImportedV1;
type PlannedRecord = Readonly<{ ordinal: number; kind: "source-event" | "legacy-artifact"; sourceRecordHash: string; sourceByteLength: number; payload: ImportedPayload; eventId: string; }>;
interface ImportResponse { readonly [key: string]: JsonValue; readonly schemaVersion: 1; readonly migrationIdentity: string; readonly packageChecksum: string; readonly batchOrdinal: number; readonly eventIds: string[]; }
type PlannedCommand = Readonly<{ recordedAt: string; eventIds: readonly string[]; command: AppendCommand<ImportResponse>; }>;
const HASH = /^[0-9a-f]{64}$/;

export class V2ShadowImporter {
  private readonly repository: SqliteV2ShadowMigrationRepository;
  public constructor(private readonly dependencies: V2ShadowImporterDependencies) {
    this.repository = new SqliteV2ShadowMigrationRepository(dependencies.connection);
  }

  public import(input: V2ShadowImportInput): V2ShadowImportResult {
    const { context, sealedPackage } = input;
    let mutationOccurred = false;
    const rawBoundary = importBoundary(this.dependencies, input.invocationDeadline, false);
    const boundary = (): void => {
      try { rawBoundary(); }
      catch (error) {
        if (mutationOccurred && error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED") {
          throw new ShadowMigrationError("MIGRATION_OUTCOME_UNKNOWN", Object.freeze({}));
        }
        throw error;
      }
    };
    boundary();
    const manifest = sealedPackage.manifest;
    const identity = sealedPackage.migrationIdentity;
    if (context.binding.projectId !== manifest.projectId || context.binding.vaultId !== manifest.vaultId || context.binding.storeId !== manifest.storeId || context.binding.workspaceId !== manifest.workspaceId) sourceInvalid();
    const migrationContext = internalMigrationContext(context, identity, manifest.createdAt);
    sealedPackage.assertUnchanged(); boundary();
    const evidence = this.repository.transact(manifest.projectId, identity, (tx) => {
      boundary();
      const run = tx.readRun();
      if (run === null || run.packageChecksum !== manifest.packageChecksum || run.sourceManifestChecksum !== manifest.sourceManifestChecksum) conflict();
      return { receipts: tx.readImportedRecords(), outboxes: tx.readCompatibilityOutbox() };
    });
    boundary();
    const prior = evidence.receipts;
    if (evidence.outboxes.some(row => !prior.some(receipt => receipt.sourceOrdinal === row.sourceOrdinal && receipt.sourceKind === "legacy-artifact"))) conflict();
    if (prior.length > manifest.recordDescriptors.length) conflict();
    const priorByOrdinal = new Map(prior.map((receipt) => [receipt.sourceOrdinal, receipt]));
    let replayed = true;
    streamBatches(sealedPackage, this.dependencies.policy, migrationContext, (batch, batchOrdinal) => {
      boundary();
      const receipts = batch.map((record) => priorByOrdinal.get(record.ordinal)).filter((receipt): receipt is ImportedRecordReceipt => receipt !== undefined);
      if (receipts.length !== 0 && receipts.length !== batch.length) conflict();
      if (receipts.length === batch.length) {
        const planned = planCommand(migrationContext, sealedPackage, batch, batchOrdinal);
        for (const [index, receipt] of receipts.entries()) {
          const record = batch[index]!;
          assertReceipt(this.dependencies.connection, receipt, record, planned.recordedAt, migrationContext.binding.projectId, boundary);
          const expected = compatibilityRecord(receipt, record);
          const actual = evidence.outboxes.filter(row => row.sourceOrdinal === record.ordinal);
          if (expected === null ? actual.length !== 0 : actual.length !== 1 || !sameOutbox(actual[0]!, expected)) conflict();
        }
      } else {
        replayed = false;
        mutationOccurred = this.appendBatch(migrationContext, sealedPackage, batch, batchOrdinal, boundary, input.invocationDeadline)
          || mutationOccurred;
      }
    }, boundary);
    boundary();
    const receipts = this.repository.transact(manifest.projectId, identity, (tx) => { boundary(); return tx.readImportedRecords(); });
    if (receipts.length !== manifest.recordDescriptors.length) conflict();
    const ordered = [...receipts].sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
    sealedPackage.assertUnchanged(); boundary();
    return importResult(sealedPackage, ordered, replayed);
  }

  public reconcile(input: V2ShadowImportInput): ShadowMigrationReconciliation<V2ShadowImportResult> {
    const authority = boundTarget(this.dependencies, true);
    authority();
    const deadline = input.invocationDeadline;
    const boundary = (): void => { deadline?.remainingMs(); authority(); };
    try {
      boundary();
      const { context, sealedPackage } = input;
      const manifest = sealedPackage.manifest;
      const identity = sealedPackage.migrationIdentity;
      if (context.binding.projectId !== manifest.projectId || context.binding.vaultId !== manifest.vaultId
        || context.binding.storeId !== manifest.storeId || context.binding.workspaceId !== manifest.workspaceId) sourceInvalid();
      const migrationContext = internalMigrationContext(context, identity, manifest.createdAt);
      const policyChecksum = shadowMigrationPolicyChecksum(this.dependencies.policy);
      if (manifest.configurationChecksum !== shadowMigrationConfigurationChecksum({ schemaVersion: 1, policyChecksum,
        packageFormatVersion: 1, migrationAlgorithmVersion: 1,
        expectedDifferencePolicyVersion: this.dependencies.policy.expectedDifferencePolicyVersion })) conflict();
      sealedPackage.assertUnchanged(); boundary();
      const productionStatements = new SqliteEventStoreStatements(this.dependencies.connection);
      const evidence = this.repository.transact(manifest.projectId, identity, tx => {
        boundary();
        const run = tx.readRun();
        boundary();
        if (run === null || run.projectId !== manifest.projectId || run.migrationIdentity !== identity
          || run.packageChecksum !== manifest.packageChecksum || run.sourceManifestChecksum !== manifest.sourceManifestChecksum
          || run.sourceTerminalPosition !== BigInt(manifest.terminalEventPosition)
          || run.sourceTerminalHash !== manifest.terminalEventHash || run.configurationChecksum !== manifest.configurationChecksum
          || run.policyChecksum !== policyChecksum
          || run.buildIdentityHash !== manifest.buildIdentityHash) conflict();
        const revision = this.dependencies.connection.prepare("SELECT build_identity_hash,migration_identity_hash,configuration_checksum FROM rollout_revisions WHERE project_id=$p AND revision_id=$r")
          .get({ $p: manifest.projectId, $r: run.rolloutRevisionId });
        boundary();
        if (revision?.build_identity_hash !== manifest.buildIdentityHash || revision.migration_identity_hash !== identity
          || revision.configuration_checksum !== manifest.configurationChecksum) conflict();
        const receipts = tx.readImportedRecords();
        boundary();
        const outboxes = tx.readCompatibilityOutbox();
        boundary();
        const plannedRecords: PlannedRecord[] = [];
        const recordedAtByOrdinal = new Map<number, string>();
        let committedBatches = 0;
        let absentBatches = 0;
        streamBatches(sealedPackage, this.dependencies.policy, migrationContext, (batch, batchOrdinal) => {
          boundary();
          const planned = planCommand(migrationContext, sealedPackage, batch, batchOrdinal);
          const append = new EventAppendTransaction(this.dependencies.connection, productionStatements,
            this.dependencies.maintenance, this.dependencies.branchScopes, deterministicIds(planned.eventIds));
          const prepared = append.prepare(planned.command, planned.recordedAt);
          boundary();
          const replay = append.findReplay(prepared, null);
          boundary();
          const commandRows = this.dependencies.connection.prepare("SELECT * FROM events WHERE project_id=$p AND command_id=$c ORDER BY command_event_index")
            .all({ $p: manifest.projectId, $c: planned.command.commandId });
          if (replay === null) {
            const command = productionStatements.findCommandId(manifest.projectId, planned.command.commandId);
            if (command !== undefined) conflict();
            if (commandRows.length !== 0) {
              if (commandRows.length > batch.length) conflict();
              for (const [index, row] of commandRows.entries()) {
                const record = batch[index];
                if (record === undefined) conflict();
                assertDurableEvent(authenticateDurable(this.dependencies.connection, row, boundary), record, planned.recordedAt, manifest.projectId);
              }
            }
            absentBatches += 1;
          } else {
            if (replay.eventIds.length !== planned.eventIds.length
              || replay.eventIds.some((eventId, index) => eventId !== planned.eventIds[index])
              || canonicalJson(replay.response) !== canonicalJson(planned.command.publicResponse)
              || replay.firstGlobalPosition > replay.lastGlobalPosition
              || replay.lastGlobalPosition - replay.firstGlobalPosition + 1n !== BigInt(batch.length)) conflict();
            readCommitted(this.dependencies.connection, manifest.projectId, batch,
              replay.firstGlobalPosition, replay.lastGlobalPosition, planned.recordedAt, boundary);
            if (commandRows.length !== batch.length) conflict();
            committedBatches += 1;
          }
          for (const record of batch) { plannedRecords.push(record); recordedAtByOrdinal.set(record.ordinal, planned.recordedAt); }
        }, boundary);
        boundary();
        if (plannedRecords.length !== manifest.recordDescriptors.length) sourceInvalid();
        const recordByOrdinal = new Map(plannedRecords.map(record => [record.ordinal, record]));
        const receiptByOrdinal = new Map<number, ImportedRecordReceipt>();
        for (const receipt of receipts) {
          if (receiptByOrdinal.has(receipt.sourceOrdinal)) conflict();
          const record = recordByOrdinal.get(receipt.sourceOrdinal);
          const recordedAt = recordedAtByOrdinal.get(receipt.sourceOrdinal);
          if (record === undefined || recordedAt === undefined) conflict();
          assertReceipt(this.dependencies.connection, receipt, record, recordedAt, manifest.projectId, boundary);
          receiptByOrdinal.set(receipt.sourceOrdinal, receipt);
        }
        const outboxByOrdinal = new Map<number, CompatibilityOutboxRecord>();
        for (const outbox of outboxes) {
          if (outboxByOrdinal.has(outbox.sourceOrdinal)) conflict();
          const record = recordByOrdinal.get(outbox.sourceOrdinal);
          const receipt = receiptByOrdinal.get(outbox.sourceOrdinal);
          if (record === undefined || receipt === undefined) conflict();
          const expected = compatibilityRecord(receipt, record);
          if (expected === null || !sameOutbox(outbox, expected)) conflict();
          outboxByOrdinal.set(outbox.sourceOrdinal, outbox);
        }
        const ownedEvents = this.dependencies.connection.prepare("SELECT event_id FROM events WHERE project_id=$p AND stream_id=$s ORDER BY stream_version")
          .all({ $p: manifest.projectId, $s: `v2-shadow-import/${identity}` });
        boundary();
        const ownedDedup = this.dependencies.connection.prepare("SELECT command_id,idempotency_key FROM command_dedup WHERE project_id=$p AND idempotency_key GLOB $prefix")
          .all({ $p: manifest.projectId, $prefix: `v2-shadow-import:${identity}:*` });
        boundary();
        const expectedEventIds = plannedRecords.map(record => record.eventId);
        if (ownedEvents.some((row, index) => typeof row.event_id !== "string" || row.event_id !== expectedEventIds[index])) conflict();
        if (ownedDedup.length > committedBatches) conflict();
        const expectedOutboxes = plannedRecords.filter(record => record.kind === "legacy-artifact").length;
        if (plannedRecords.length === 0) {
          if (ownedEvents.length !== 0 || ownedDedup.length !== 0 || receipts.length !== 0 || outboxes.length !== 0) conflict();
          return Object.freeze({ status: "committed" as const, result: importResult(sealedPackage, [], true) });
        }
        const fullyAbsent = committedBatches === 0 && absentBatches > 0 && ownedEvents.length === 0
          && ownedDedup.length === 0 && receipts.length === 0 && outboxes.length === 0;
        if (fullyAbsent) return Object.freeze({ status: "absent" as const });
        const fullyCommitted = absentBatches === 0 && committedBatches > 0
          && ownedEvents.length === plannedRecords.length && ownedDedup.length === committedBatches
          && receipts.length === plannedRecords.length && outboxes.length === expectedOutboxes
          && plannedRecords.every(record => receiptByOrdinal.has(record.ordinal)
            && (record.kind === "source-event" || outboxByOrdinal.has(record.ordinal)));
        if (fullyCommitted) return Object.freeze({ status: "committed" as const,
          result: importResult(sealedPackage, receipts, true) });
        return Object.freeze({ status: "unknown" as const, safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" as const });
      });
      boundary(); sealedPackage.assertUnchanged(); boundary();
      return evidence;
    } catch (error) {
      if (error instanceof ShadowMigrationError) {
        if (error.code === "MIGRATION_RETRY_EXHAUSTED") {
          return Object.freeze({ status: "unknown", safeErrorCode: "MIGRATION_RETRY_EXHAUSTED" });
        }
        throw error;
      }
      if (error instanceof EventStoreError && ["IDEMPOTENCY_CONFLICT", "INTEGRITY_FAILURE", "PROJECT_IDENTITY_MISMATCH", "COMMAND_INVALID"].includes(error.code)) conflict();
      return Object.freeze({ status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });
    }
  }

  private appendBatch(context: ProjectContext, package_: SealedV2MigrationPackage, batch: readonly PlannedRecord[], batchOrdinal: number,
    boundary: () => void, deadline?: ShadowMigrationInvocationDeadline): boolean {
    if (batch.length === 0) return false;
    boundary();
    const identity = package_.migrationIdentity;
    const planned = planCommand(context, package_, batch, batchOrdinal);
    const faultInjector = { hit: (point: Parameters<NonNullable<V2ShadowImporterDependencies["faultInjector"]>["hit"]>[0],
      context_: Parameters<NonNullable<V2ShadowImporterDependencies["faultInjector"]>["hit"]>[1]): void => {
      this.dependencies.faultInjector?.hit(point, context_);
      try { boundary(); }
      catch (error) { if (error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED") {
        throw new EventStoreError("MIGRATION_RETRY_EXHAUSTED"); } throw error; }
    } };
    const eventStore = new EventStore(this.dependencies.connection, this.dependencies.statements, this.dependencies.maintenance, this.dependencies.branchScopes,
      () => planned.recordedAt, deterministicIds(planned.eventIds), faultInjector);
    let durableMutation = false;
    try {
      const result = eventStore.append(planned.command);
      durableMutation = !result.deduplicated;
      boundary();
      if (canonicalJson(result.response) !== canonicalJson(planned.command.publicResponse) || result.eventIds.length !== batch.length || result.eventIds.some((id, index) => id !== planned.eventIds[index])) conflict();
      const receipts = readCommitted(this.dependencies.connection, context.binding.projectId, batch,
        result.firstGlobalPosition, result.lastGlobalPosition, planned.recordedAt, boundary);
      boundary();
      this.repository.transact(context.binding.projectId, identity, (tx) => {
        boundary();
        const existing = tx.readImportedRecords();
        const outboxes = tx.readCompatibilityOutbox();
        if (outboxes.some(row => !existing.some(receipt => receipt.sourceOrdinal === row.sourceOrdinal && receipt.sourceKind === "legacy-artifact"))) conflict();
        for (const [index, receipt] of receipts.entries()) {
          const found = existing.find(value => value.sourceOrdinal === receipt.sourceOrdinal);
          if (found === undefined) continue;
          if (Object.keys(receipt).some(key => found[key as keyof ImportedRecordReceipt] !== receipt[key as keyof ImportedRecordReceipt])) conflict();
          const expected = compatibilityRecord(receipt, batch[index]!);
          const actual = outboxes.filter(row => row.sourceOrdinal === receipt.sourceOrdinal);
          if (expected === null ? actual.length !== 0 : actual.length !== 1 || !sameOutbox(actual[0]!, expected)) conflict();
        }
        tx.insertImportedRecords(receipts);
        tx.enqueueCompatibility(receipts.flatMap((receipt, index) => {
          const row = compatibilityRecord(receipt, batch[index]!); return row === null ? [] : [row];
        }));
      });
      durableMutation = true;
      boundary();
      return durableMutation;
    } catch (error) {
      if (error instanceof ShadowMigrationError) {
        if (durableMutation && error.code === "MIGRATION_RETRY_EXHAUSTED") {
          throw new ShadowMigrationError("MIGRATION_OUTCOME_UNKNOWN", Object.freeze({ batchOrdinal }), { cause: error });
        }
        throw error;
      }
      if (error instanceof EventStoreError && error.code === "MIGRATION_RETRY_EXHAUSTED") {
        throw new ShadowMigrationError("MIGRATION_RETRY_EXHAUSTED", Object.freeze({ batchOrdinal }), { cause: error });
      }
      if (error instanceof EventStoreError && error.code === "COMMAND_OUTCOME_UNKNOWN") throw new ShadowMigrationError("MIGRATION_OUTCOME_UNKNOWN", Object.freeze({ batchOrdinal }), { cause: error });
      if (error instanceof EventStoreError && error.code === "COMMAND_TOO_LARGE") limit(batch[0]!.ordinal);
      if (error instanceof EventStoreError) throw new ShadowMigrationError("MIGRATION_IDENTITY_CONFLICT", Object.freeze({ batchOrdinal }), { cause: error });
      if (durableMutation && deadline?.signal.aborted) throw new ShadowMigrationError("MIGRATION_OUTCOME_UNKNOWN", Object.freeze({ batchOrdinal }), { cause: error });
      throw error;
    }
  }

}

function boundTarget(dependencies: V2ShadowImporterDependencies, required: boolean): () => void {
  const path = dependencies.eventStorePath;
  if (path === undefined) {
    if (required) conflict();
    return (): void => {};
  }
  const identity = captureCompatibilityPath(path, false);
  return (): void => {
    assertBoundSqliteConnectionIdentity(dependencies.connection, path, identity);
    const current = captureCompatibilityPath(path, false);
    if (current.device !== identity.device || current.inode !== identity.inode) conflict();
  };
}

function importBoundary(dependencies: V2ShadowImporterDependencies, deadline: ShadowMigrationInvocationDeadline | undefined,
  requireBoundTarget: boolean): () => void {
  const authority = boundTarget(dependencies, requireBoundTarget);
  return (): void => { deadline?.remainingMs(); authority(); };
}

function importResult(package_: SealedV2MigrationPackage, receipts: readonly ImportedRecordReceipt[], deduplicated: boolean): V2ShadowImportResult {
  const ordered = [...receipts].sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
  const first = ordered[0] ?? null;
  const terminal = ordered.at(-1) ?? null;
  return Object.freeze({ schemaVersion: 1, migrationIdentity: package_.migrationIdentity,
    packageChecksum: package_.manifest.packageChecksum, recordCount: package_.manifest.recordDescriptors.length,
    eventIds: Object.freeze(ordered.map(receipt => receipt.importedEventId)), firstImportedPosition: first?.importedGlobalPosition ?? null,
    terminalImportedPosition: terminal?.importedGlobalPosition ?? null,
    terminalImportedEventHash: terminal?.importedEventHash ?? "0".repeat(64),
    importedEventsChecksum: checksum(ordered.map(receipt => ({ ordinal: receipt.sourceOrdinal,
      eventId: receipt.importedEventId, position: receipt.importedGlobalPosition.toString(), eventHash: receipt.importedEventHash }))),
    deduplicated });
}

function compatibilityRecord(receipt: ImportedRecordReceipt, record: PlannedRecord): CompatibilityOutboxRecord | null {
  if (record.kind !== "legacy-artifact") return null;
  const payload = record.payload as V1LegacyArtifactImportedV1;
  return Object.freeze({ projectId: receipt.projectId, migrationIdentity: receipt.migrationIdentity,
    outboxId: deterministicMigrationUuid("claim", receipt.migrationIdentity, receipt.sourceOrdinal), sourceOrdinal: receipt.sourceOrdinal,
    importedEventId: receipt.importedEventId, importedGlobalPosition: receipt.importedGlobalPosition, importedEventHash: receipt.importedEventHash,
    triggeringPayloadHash: payloadHash(payload as unknown as JsonValue), relativePath: payload.relativePath, byteLength: record.sourceByteLength,
    contentSha256: payload.contentSha256, materializationRevision: BigInt(receipt.sourceOrdinal + 1), recordedAt: receipt.recordedAt });
}
function sameOutbox(left: CompatibilityOutboxRecord, right: CompatibilityOutboxRecord): boolean {
  return Object.keys(right).every(key => left[key as keyof CompatibilityOutboxRecord] === right[key as keyof CompatibilityOutboxRecord]);
}

function internalMigrationContext(
  caller: ProjectContext,
  migrationIdentity: string,
  createdAt: string,
): ProjectContext {
  const root = `v2-shadow-import/${migrationIdentity}`;
  const workspace = Object.freeze({ kind: "non-git" as const, workspaceRoot: root, workspaceId: caller.binding.workspaceId });
  const binding = Object.freeze({
    projectBindingId: `v2-shadow-import:${migrationIdentity}`,
    generation: 1,
    contextFingerprint: `v2-shadow-import:${migrationIdentity}`,
    source: "explicit-cli" as const,
    projectId: caller.binding.projectId,
    vaultId: caller.binding.vaultId,
    storeId: caller.binding.storeId,
    workspaceId: caller.binding.workspaceId,
    clientNamespace: "v2-shadow-importer",
    clientInstanceId: `v2-shadow-importer:${migrationIdentity}`,
    actorRole: "untrusted" as const,
    projectRoot: root,
    vaultRoot: `${root}/vault`,
    descriptorPath: `${root}/vault/.project-memory.json`,
    storeRoute: Object.freeze({ kind: "vault-local" as const, storeRoot: root, eventsPath: `${root}/events.sqlite`,
      storeManifestPath: `${root}/store.json`, projectionManifestPath: `${root}/projection.json` }),
    workspace,
    establishedAt: createdAt,
  });
  return Object.freeze({ binding, workspace, checkedAt: createdAt });
}

function planRecord(record: V2MigrationPackageRecordV1, identity: string, index: number, boundary: () => void = () => {}): PlannedRecord {
  boundary();
  const descriptor = record.descriptor;
  if (descriptor.ordinal !== index || !HASH.test(descriptor.contentSha256)) sourceInvalid();
  const chunks: Buffer[] = [];
  for (const chunk of record.readChunks()) { boundary(); chunks.push(Buffer.from(chunk)); }
  boundary();
  const bytes = Buffer.concat(chunks);
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
  consume: (batch: readonly PlannedRecord[], batchOrdinal: number) => void, boundary: () => void = () => {}): void {
  const maxEvents = Math.min(policy.maxBatchEvents, MAX_EVENTS_PER_COMMAND); const maxBytes = Math.min(policy.maxBatchBytes, MAX_CANONICAL_COMMAND_BYTES);
  let batch: PlannedRecord[] = []; let ordinal = 0; let batchOrdinal = 0;
  for (const sourceRecord of package_.records()) {
    boundary();
    const record = planRecord(sourceRecord, package_.migrationIdentity, ordinal, boundary);
    if (record.sourceByteLength > policy.maxEventBytes) limit(record.ordinal);
    let candidate = [...batch, record];
    if (candidate.length > maxEvents || commandBytes(planCommand(context, package_, candidate, batchOrdinal).command) > maxBytes) {
      if (batch.length === 0) limit(record.ordinal);
      boundary(); consume(Object.freeze(batch), batchOrdinal++); boundary(); batch = []; candidate = [record];
      if (commandBytes(planCommand(context, package_, candidate, batchOrdinal).command) > maxBytes) limit(record.ordinal);
    }
    batch = candidate; ordinal += 1;
    if (batch.length === maxEvents) { boundary(); consume(Object.freeze(batch), batchOrdinal++); boundary(); batch = []; }
  }
  boundary();
  if (ordinal !== package_.manifest.recordDescriptors.length) sourceInvalid();
  if (batch.length > 0) { consume(Object.freeze(batch), batchOrdinal); boundary(); }
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
function authenticateDurable(connection: SqliteConnection, row: SqliteRow, boundary: () => void = () => {}): StoredEvent {
  boundary();
  const event = storedEvent(row); let previousEventHash = GENESIS_GLOBAL_HASH;
  if (event.globalPosition > 1n) { const prior = connection.prepare("SELECT event_hash FROM events WHERE global_position=$position").get({$position:event.globalPosition-1n});
    if (prior === undefined) conflict(); previousEventHash = rowString(prior,"event_hash"); }
  boundary();
  try { authenticateStoredEvent(event,{expectedPosition:event.globalPosition,previousEventHash}); } catch { conflict(); }
  boundary();
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
function assertReceipt(connection: SqliteConnection, receipt: ImportedRecordReceipt, record: PlannedRecord, recordedAt: string, projectId: string,
  boundary: () => void = () => {}): void {
  boundary();
  const identity=(record.payload as {migrationIdentity:string}).migrationIdentity;
  if(receipt.projectId!==projectId||receipt.migrationIdentity!==identity||receipt.sourceOrdinal!==record.ordinal||receipt.sourceKind!==record.kind
    ||receipt.sourceRecordHash!==record.sourceRecordHash||receipt.importedEventId!==record.eventId||receipt.recordedAt!==recordedAt) conflict();
  const row=connection.prepare("SELECT * FROM events WHERE project_id=$projectId AND global_position=$position").get({$projectId:projectId,$position:receipt.importedGlobalPosition});
  boundary();
  if(row===undefined) conflict(); const event=authenticateDurable(connection,row,boundary);
  if(event.eventId!==receipt.importedEventId||event.eventHash!==receipt.importedEventHash) conflict(); assertDurableEvent(event,record,recordedAt,projectId);
  boundary();
}

function readCommitted(connection: SqliteConnection, projectId: string, records: readonly PlannedRecord[], first: bigint, last: bigint, recordedAt: string,
  boundary: () => void = () => {}): readonly ImportedRecordReceipt[] {
  boundary();
  const rows = connection.prepare("SELECT * FROM events WHERE project_id=$projectId AND global_position BETWEEN $first AND $last ORDER BY global_position").all({ $projectId: projectId, $first: first, $last: last });
  boundary();
  if (rows.length !== records.length) conflict();
  const receipts = rows.map((row, index) => { boundary(); const record = records[index]!; const event=authenticateDurable(connection,row,boundary); assertDurableEvent(event,record,recordedAt,projectId);
    return Object.freeze({ projectId, migrationIdentity: (record.payload as { migrationIdentity: string }).migrationIdentity, sourceOrdinal: record.ordinal, sourceKind: record.kind,
      sourceRecordHash: record.sourceRecordHash, importedEventId: record.eventId, importedGlobalPosition: event.globalPosition, importedEventHash: event.eventHash, recordedAt }); });
  boundary();
  return Object.freeze(receipts);
}

function deterministicIds(ids: readonly string[]): () => string { let index = 0; return () => ids[index++] ?? deterministicMigrationUuid("event", "0".repeat(64), index); }
function checksum(value: string | Uint8Array | unknown): string { const hash = createHash("sha256"); if (typeof value === "string") hash.update(value, "utf8"); else if (value instanceof Uint8Array) hash.update(value); else hash.update(canonicalJson(value as JsonValue), "utf8"); return hash.digest("hex"); }
function sourceInvalid(): never { throw new ShadowMigrationError("MIGRATION_SOURCE_INVALID", Object.freeze({})); }
function conflict(): never { throw new ShadowMigrationError("MIGRATION_IDENTITY_CONFLICT", Object.freeze({})); }
function limit(ordinal: number): never { throw new ShadowMigrationError("MIGRATION_LIMIT_EXCEEDED", Object.freeze({ ordinal })); }
