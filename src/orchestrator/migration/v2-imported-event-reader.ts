import { createHash } from "node:crypto";
import type { StoredEvent } from "../contracts/event.js";
import { authenticateStoredEvent, type StoredEventChainCursor } from "../integrity/stored-event-authenticator.js";
import type { ProjectBinding } from "../projections/contracts.js";
import { MAX_PROJECTION_SOURCE_BYTES, MAX_PROJECTION_SOURCE_EVENTS, type ProjectionEventReader, type ProjectionEventSnapshot } from "../projections/event-reader.js";
import { decodeProjectionEvent } from "../projections/source-event-codec.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { GENESIS_GLOBAL_HASH } from "../storage/event-store.js";
import type { SqliteConnection, SqliteDriver, SqliteRow } from "../storage/sqlite-driver.js";
import { decodeV1SourceCopyManifestV1, type V1SourceCopyManifestV1 } from "./v1-source-copy.js";
import type { SealedV2MigrationPackage, V2MigrationRecordDescriptorV1 } from "./v2-migration-package.js";
import { deterministicMigrationUuid, ShadowMigrationError } from "./v2-shadow-migration.contracts.js";

export interface V2ImportedProjectionEventReaderOptions {
  readonly driver: SqliteDriver;
  readonly eventStorePath: string;
  readonly sealedPackage: SealedV2MigrationPackage;
  /** The package checksum binds this manifest, including otherwise absent branch provenance. */
  readonly sourceManifest: V1SourceCopyManifestV1;
  readonly busyTimeoutMs?: number;
}

const SOURCE_FIELDS = ["globalPosition", "eventId", "projectId", "vaultId", "storeId", "workspaceId",
  "branchScopeId", "branchRef", "streamId", "streamType", "streamVersion", "eventType", "eventSchemaVersion",
  "sessionId", "parentSessionId", "actorRole", "agentId", "clientInstanceId", "correlationId", "causationId",
  "commandId", "idempotencyKey", "commandEventIndex", "occurredAt", "recordedAt", "visibilityScope", "confidence",
  "verificationStatus", "sourceRefs", "evidenceRefs", "evidenceDigests", "payloadJson", "payloadHash",
  "previousGlobalHash", "eventHash", "lifecycleIntentJson"] as const;
const BINDING_FIELDS = ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId"] as const;
const JSON_FIELDS = new Set(["sourceRefs", "evidenceRefs", "evidenceDigests"]);
const INTEGER_FIELDS = new Set(["eventSchemaVersion", "commandEventIndex"]);
const INT64_MAX = 9_223_372_036_854_775_807n;
const MAX_EVENT_BYTES = 1024 * 1024;
const column = (field: string): string => field.replace(/[A-Z]/g, character => `_${character.toLowerCase()}`)
  + (JSON_FIELDS.has(field) ? "_json" : "");
const COLUMNS = SOURCE_FIELDS.map(column);
const ROW_BYTES = COLUMNS.map(name => `CASE WHEN ${name} IS NULL THEN 8 WHEN typeof(${name}) IN ('text','blob') THEN length(CAST(${name} AS BLOB)) ELSE 8 END`).join(" + ");

function integrity(): never { throw new ShadowMigrationError("MIGRATION_LEDGER_INTEGRITY_FAILURE", Object.freeze({})); }
function protect<T>(operation: () => T): T { try { return operation(); } catch { return integrity(); } }
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) integrity();
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) integrity();
  return value as Record<string, unknown>;
}
function decimal(value: unknown, minimum = 1n): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) integrity();
  const number = BigInt(value);
  if (number < minimum || number > INT64_MAX) integrity();
  return number;
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function cursor(): StoredEventChainCursor { return { expectedPosition: 1n, previousEventHash: GENESIS_GLOBAL_HASH }; }
function sameBinding(event: StoredEvent | ProjectBinding, binding: ProjectBinding): boolean {
  return BINDING_FIELDS.every(key => key === "sessionId" || event[key] === binding[key]);
}

/** Decode envelopes with the production codec; the payload cache remains immutable and content-free. */
function sourceEvent(value: unknown, binding: ProjectBinding): StoredEvent {
  const fields = exact(value, SOURCE_FIELDS);
  if (fields.eventType === "V1ProjectionSourceImported" || fields.eventType === "V1LegacyArtifactImported") integrity();
  if (BINDING_FIELDS.some(key => key !== "sessionId" && fields[key] !== binding[key])
    || !Array.isArray(fields.sourceRefs) || !Array.isArray(fields.evidenceRefs) || !Array.isArray(fields.evidenceDigests)) integrity();
  const event = Object.freeze({ ...fields, globalPosition: decimal(fields.globalPosition),
    streamVersion: decimal(fields.streamVersion), sourceRefs: Object.freeze([...(fields.sourceRefs as string[])]),
    evidenceRefs: Object.freeze([...(fields.evidenceRefs as [])]), evidenceDigests: Object.freeze([...(fields.evidenceDigests as [])]),
    payload: Object.freeze({}) }) as unknown as StoredEvent;
  decodeProjectionEvent(event);
  return event;
}
function targetEvent(row: SqliteRow): StoredEvent {
  const fields = Object.fromEntries(SOURCE_FIELDS.map(field => {
    const value = row[column(field)];
    return [field, JSON_FIELDS.has(field) ? JSON.parse(value as string) as unknown
      : INTEGER_FIELDS.has(field) ? Number(value) : value];
  }));
  const event = { ...fields, payload: Object.freeze({}) } as unknown as StoredEvent;
  // The full target chain is authenticated, even across other streams/workspaces.
  decodeProjectionEvent(event);
  return event;
}
function sourceRowBytes(event: StoredEvent): number {
  return SOURCE_FIELDS.reduce((bytes, field) => {
    const value = event[field];
    return bytes + (JSON_FIELDS.has(field) ? Buffer.byteLength(canonicalJson(value), "utf8")
      : typeof value === "string" ? Buffer.byteLength(value, "utf8") : 8);
  }, 0);
}

export class V2ImportedProjectionEventReader implements ProjectionEventReader {
  readonly #options: V2ImportedProjectionEventReaderOptions;
  constructor(options: V2ImportedProjectionEventReaderOptions) { this.#options = Object.freeze({ ...options }); }

  openSnapshot(binding: ProjectBinding): Promise<ProjectionEventSnapshot> { return this.openCommittedSnapshot(binding); }

  async openCommittedSnapshot(requested: ProjectBinding): Promise<ProjectionEventSnapshot> {
    const options = this.#options;
    let connection: SqliteConnection | undefined;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (connection === undefined) return;
      try { connection.exec("ROLLBACK"); } finally { connection.close(); }
    };
    try {
      const source = decodeV1SourceCopyManifestV1(options.sourceManifest);
      const package_ = options.sealedPackage;
      package_.assertUnchanged();
      const manifest = package_.manifest;
      const identity = package_.migrationIdentity;
      if (source.manifestChecksum !== manifest.sourceManifestChecksum
        || ["projectId", "vaultId", "storeId", "workspaceId", "eventCount", "aggregateSourceBytes", "terminalEventPosition", "terminalEventHash", "createdAt"].some(
          key => source[key as keyof V1SourceCopyManifestV1] !== manifest[key as keyof typeof manifest])
        || source.legacyArtifacts.length !== manifest.legacyArtifactCount
        || manifest.eventCount > MAX_PROJECTION_SOURCE_EVENTS || manifest.aggregateSourceBytes > MAX_PROJECTION_SOURCE_BYTES) integrity();
      const binding = Object.freeze(Object.fromEntries(BINDING_FIELDS.map(key => [key, key === "sessionId" ? null : source[key]]))) as unknown as ProjectBinding;
      exact(requested, BINDING_FIELDS);
      if (!sameBinding(requested, binding) || requested.sessionId !== null) integrity();
      connection = options.driver.open(options.eventStorePath, { mode: "read-only-existing", busyTimeoutMs: options.busyTimeoutMs ?? 5000 });
      connection.exec("BEGIN");
      const scope = { $p: binding.projectId, $m: identity };
      const meta = connection.prepare("SELECT project_id,vault_id,store_id FROM project_meta WHERE singleton=1").get();
      if (meta?.project_id !== binding.projectId || meta.vault_id !== binding.vaultId || meta.store_id !== binding.storeId) integrity();
      const run = connection.prepare("SELECT * FROM v2_shadow_migration_runs WHERE project_id=$p AND migration_identity=$m").get(scope);
      if (run === undefined || run.package_checksum !== manifest.packageChecksum || run.source_manifest_checksum !== source.manifestChecksum
        || run.source_terminal_position !== decimal(manifest.terminalEventPosition, 0n) || run.source_terminal_hash !== manifest.terminalEventHash
        || run.configuration_checksum !== manifest.configurationChecksum || run.build_identity_hash !== manifest.buildIdentityHash) integrity();
      const ledger = connection.prepare("SELECT count(*) AS count, coalesce(max(imported_global_position),0) AS terminal FROM v2_shadow_imported_records WHERE project_id=$p AND migration_identity=$m").get(scope);
      const terminal = ledger?.terminal;
      if (ledger?.count !== BigInt(manifest.recordDescriptors.length) || typeof terminal !== "bigint" || terminal < 0n || terminal > INT64_MAX) integrity();
      // A complete import cannot hide an extra or unreceipted migration event beyond its claimed cutoff.
      const stream = connection.prepare("SELECT count(*) AS count FROM events WHERE stream_id=$stream")
        .get({ $stream: `v2-shadow-import/${identity}` });
      if (stream?.count !== ledger.count) integrity();
      const bounds = connection.prepare(`SELECT count(*) AS count, coalesce(sum(${ROW_BYTES}),0) AS bytes, coalesce(max(${ROW_BYTES}),0) AS maximum FROM events WHERE global_position <= $terminal`).get({ $terminal: terminal });
      if (bounds === undefined || typeof bounds.count !== "bigint" || typeof bounds.bytes !== "bigint" || typeof bounds.maximum !== "bigint"
        || bounds.count > BigInt(MAX_PROJECTION_SOURCE_EVENTS) || bounds.bytes > BigInt(MAX_PROJECTION_SOURCE_BYTES) || bounds.maximum > BigInt(MAX_EVENT_BYTES)) integrity();
      const rows = connection.prepare(`SELECT ${COLUMNS.join(",")} FROM events WHERE global_position <= $terminal ORDER BY global_position`);
      const receiptAt = connection.prepare("SELECT * FROM v2_shadow_imported_records WHERE project_id=$p AND migration_identity=$m AND source_ordinal=$o");
      let aggregateBytes = 0;
      let packageBytes = 0;
      let eventCount = 0;
      let ordinal = 0;
      let targetCursor = cursor();
      let sourceCursor = cursor();
      const decodeWrapper = (event: StoredEvent, descriptor: V2MigrationRecordDescriptorV1): StoredEvent | null => {
        const sourceKind = descriptor.kind === "source-event";
        if (event.eventType !== (sourceKind ? "V1ProjectionSourceImported" : "V1LegacyArtifactImported")
          || event.eventSchemaVersion !== 1 || event.streamType !== "migration" || event.workspaceId !== binding.workspaceId
          || event.branchScopeId !== null || event.branchRef !== null || event.sessionId !== null || event.parentSessionId !== null) integrity();
        const payload = exact(JSON.parse(event.payloadJson), sourceKind
          ? ["schemaVersion", "migrationIdentity", "sourceOrdinal", "sourceRecordHash", "sourceEvent"]
          : ["schemaVersion", "migrationIdentity", "sourceOrdinal", "sourceRecordHash", "relativePath", "contentSha256", "contentUtf8"]);
        if (payload.schemaVersion !== 1 || payload.migrationIdentity !== identity || payload.sourceOrdinal !== descriptor.ordinal
          || payload.sourceRecordHash !== descriptor.contentSha256) integrity();
        if (sourceKind) {
          const reconstructed = sourceEvent(payload.sourceEvent, binding);
          if (reconstructed.eventId !== descriptor.sourceIdentity) integrity();
          // Package envelopes include the producer's content-free cache, omitted by the wrapper.
          const record = canonicalJson({ ...(payload.sourceEvent as object), payload: {} });
          if (Buffer.byteLength(record, "utf8") !== descriptor.byteLength || hash(record) !== descriptor.contentSha256) integrity();
          return reconstructed;
        }
        if (typeof payload.contentUtf8 !== "string" || payload.relativePath !== descriptor.relativePath
          || payload.contentSha256 !== descriptor.contentSha256 || descriptor.sourceIdentity !== descriptor.contentSha256
          || Buffer.byteLength(payload.contentUtf8, "utf8") !== descriptor.byteLength || hash(payload.contentUtf8) !== descriptor.contentSha256) integrity();
        return null;
      };
      // Complete validation before exposing any source input; no source payload array is retained.
      for (const row of rows.iterate({ $terminal: terminal })) {
        const event = targetEvent(row);
        targetCursor = authenticateStoredEvent(event, targetCursor).nextCursor;
        if (event.projectId !== binding.projectId || event.vaultId !== binding.vaultId || event.storeId !== binding.storeId) integrity();
        if (event.streamId !== `v2-shadow-import/${identity}`) continue;
        const descriptor = manifest.recordDescriptors[ordinal];
        if (descriptor === undefined || descriptor.ordinal !== ordinal) integrity();
        const receipt = receiptAt.get({ ...scope, $o: ordinal });
        if (receipt === undefined || receipt.source_ordinal !== BigInt(ordinal) || receipt.source_kind !== descriptor.kind
          || receipt.source_record_hash !== descriptor.contentSha256 || receipt.imported_event_id !== event.eventId
          || event.eventId !== deterministicMigrationUuid("event", identity, ordinal)
          || receipt.imported_global_position !== event.globalPosition || receipt.imported_event_hash !== event.eventHash
          || receipt.recorded_at !== event.recordedAt || event.streamVersion !== BigInt(ordinal + 1)) integrity();
        const reconstructed = decodeWrapper(event, descriptor);
        if (reconstructed !== null) {
          const authenticated = authenticateStoredEvent(reconstructed, sourceCursor);
          sourceCursor = authenticated.nextCursor;
          packageBytes += authenticated.byteLength;
          const bytes = sourceRowBytes(reconstructed);
          if (bytes > MAX_EVENT_BYTES) integrity();
          aggregateBytes += bytes;
          eventCount += 1;
        } else packageBytes += descriptor.byteLength;
        ordinal += 1;
      }
      if (targetCursor.expectedPosition !== terminal + 1n || ordinal !== manifest.recordDescriptors.length
        || eventCount !== manifest.eventCount || packageBytes !== manifest.aggregateSourceBytes || aggregateBytes > MAX_PROJECTION_SOURCE_BYTES
        || sourceCursor.expectedPosition !== decimal(manifest.terminalEventPosition, 0n) + 1n || sourceCursor.previousEventHash !== manifest.terminalEventHash) integrity();
      const requireOpen = (): void => { if (closed) integrity(); };
      return Object.freeze({ binding, eventCount, aggregateBytes, terminalEventPosition: decimal(manifest.terminalEventPosition, 0n),
        terminalEventHash: manifest.terminalEventHash,
        events(): Iterable<StoredEvent> {
          requireOpen();
          return (function* (): IterableIterator<StoredEvent> {
            try {
              requireOpen();
              // Keyset reads avoid leaving active SQLite statements alive across a caller yield/close.
              let nextOrdinal = 0;
              while (nextOrdinal < manifest.eventCount) {
                requireOpen();
                const descriptor = manifest.recordDescriptors[nextOrdinal];
                if (descriptor === undefined || descriptor.kind !== "source-event") integrity();
                const receipt = receiptAt.get({ ...scope, $o: nextOrdinal++ });
                const row = connection!.prepare(`SELECT ${COLUMNS.join(",")} FROM events WHERE global_position=$position`)
                  .get({ $position: receipt!.imported_global_position! });
                if (row === undefined) integrity();
                const event = decodeWrapper(targetEvent(row), descriptor);
                if (event === null) integrity();
                yield event;
              }
              requireOpen();
            } catch { try { close(); } catch { /* preserve redacted integrity failure */ } integrity(); }
          })();
        },
        close(): void { protect(close); },
      });
    } catch {
      try { close(); } catch { /* preserve redacted integrity failure */ }
      return integrity();
    }
  }
}
