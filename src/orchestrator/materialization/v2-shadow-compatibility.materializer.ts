import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { StoredEvent } from "../contracts/event.js";
import { resolveContainedProjectPath } from "../identity/canonical-path.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { replayCommittedProjectionEvents } from "../projections/event-reader.js";
import type { SqliteConnection, SqliteDriver } from "../storage/sqlite-driver.js";
import { SqliteV2ShadowMigrationRepository, type CompatibilityAcknowledgement, type CompatibilityClaim,
  type CompatibilityOutboxRecord, type V2ShadowMigrationTransaction } from "../storage/v2-shadow-migration.repository.js";
import type { VerifiedV1SourceCopy } from "../migration/v1-source-copy.js";
import type { SealedV2MigrationPackage } from "../migration/v2-migration-package.js";
import { V2ImportedProjectionEventReader } from "../migration/v2-imported-event-reader.js";
import { decodeShadowMigrationPolicyV1, deterministicMigrationUuid, shadowMigrationPolicyChecksum,
  ShadowMigrationError, type ShadowMigrationPolicyV1 } from "../migration/v2-shadow-migration.contracts.js";
import { StableCompatibilityDirectory, captureCompatibilityPath } from "./stable-compatibility-directory.js";

export interface CompatibilityMaterializationResult {
  readonly schemaVersion: 1;
  readonly migrationIdentity: string;
  readonly acknowledgedCount: number;
  readonly highestAcknowledgedSourceOrdinal: number | null;
  readonly acknowledgedImportedPosition: bigint | null;
  readonly materializationRevision: bigint | null;
  readonly aggregateBytes: number;
  readonly artifactSetChecksum: string;
  readonly deduplicated: boolean;
}
export interface CompatibilityMaterializationInput {
  readonly source: VerifiedV1SourceCopy;
  readonly sealedPackage: SealedV2MigrationPackage;
  readonly rolloutRevisionId: string;
}
export interface V2ShadowCompatibilityMaterializerOptions {
  readonly connection: SqliteConnection;
  readonly driver: SqliteDriver;
  readonly eventStorePath: string;
  readonly isolatedRoot: string;
  readonly liveEventStorePath: string;
  readonly liveVaultRoot: string;
  readonly policy: ShadowMigrationPolicyV1;
  readonly operationNow?: () => number;
  readonly acknowledgementNow?: (createdAt: string, sourceOrdinal: number) => string;
}
function fail(unknown = false): never { throw new ShadowMigrationError(unknown ? "MIGRATION_OUTCOME_UNKNOWN" : "COMPATIBILITY_INTEGRITY_FAILURE"); }
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function decimal(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(decimal);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decimal(entry)]));
}
const equal = (a: unknown, b: unknown) => canonicalJson(decimal(a)) === canonicalJson(decimal(b));
function overlap(a: string, b: string): boolean {
  const part = relative(a, b); return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}
const clock = (createdAt: string, ordinal: number) => new Date(Date.parse(createdAt) + ordinal).toISOString();

export class V2ShadowCompatibilityMaterializer {
  readonly #options: V2ShadowCompatibilityMaterializerOptions;
  constructor(options: V2ShadowCompatibilityMaterializerOptions) { this.#options = Object.freeze({ ...options }); }

  async materializePending(input: CompatibilityMaterializationInput): Promise<CompatibilityMaterializationResult> {
    let uncertain = false;
    try {
      const options = this.#options, policy = decodeShadowMigrationPolicyV1(options.policy);
      const now = options.operationNow ?? (() => performance.now()), start = now();
      const remaining = () => { const elapsed = now() - start;
        if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= policy.deadlineMs) throw new ShadowMigrationError("MIGRATION_LIMIT_EXCEEDED");
        return Math.max(1, Math.floor(policy.deadlineMs - elapsed)); };
      const source = input.source, package_ = input.sealedPackage, manifest = package_.manifest, migration = package_.migrationIdentity;
      const binding = source.projectionSnapshot.binding;
      source.assertUnchanged(); package_.assertUnchanged();
      const targetIdentity = captureCompatibilityPath(options.eventStorePath, false);
      const forbiddenRoots = [options.liveVaultRoot, dirname(options.liveEventStorePath), source.sourceRoot, package_.rootPath];
      const stable = new StableCompatibilityDirectory({ rootPath: options.isolatedRoot, forbiddenRoots });
      if (overlap(options.isolatedRoot, options.eventStorePath) || overlap(options.eventStorePath, options.isolatedRoot)) fail();
      const liveIdentity = captureCompatibilityPath(options.liveEventStorePath, false);
      const sameIdentity = (a: typeof targetIdentity, b: typeof targetIdentity) => a.device === b.device && a.inode === b.inode;
      if (sameIdentity(targetIdentity, liveIdentity)) fail();
      for (const protectedRoot of forbiddenRoots) if (overlap(protectedRoot, options.eventStorePath)) fail();
      const checkConnection = () => {
        remaining(); source.assertUnchanged(); package_.assertUnchanged();
        if (!sameIdentity(targetIdentity, captureCompatibilityPath(options.eventStorePath, false))) fail();
        const database = options.connection.prepare("PRAGMA database_list").all().find(row => row.name === "main");
        if (typeof database?.file !== "string" || !sameIdentity(targetIdentity, captureCompatibilityPath(database.file, false))) fail();
      };
      checkConnection();
      // The repository's only authority is the identity-verified target connection.
      const repository = new SqliteV2ShadowMigrationRepository(options.connection);
      const transact = <T>(callback: (tx: V2ShadowMigrationTransaction) => T): T => {
        checkConnection();
        return repository.transact(binding.projectId, migration, tx => {
          const run = tx.readRun();
          if (!run || run.rolloutRevisionId !== input.rolloutRevisionId || run.packageChecksum !== manifest.packageChecksum
            || run.sourceManifestChecksum !== source.manifest.manifestChecksum || run.sourceManifestChecksum !== manifest.sourceManifestChecksum
            || run.sourceTerminalPosition !== BigInt(manifest.terminalEventPosition) || run.sourceTerminalHash !== manifest.terminalEventHash
            || run.configurationChecksum !== manifest.configurationChecksum || run.policyChecksum !== shadowMigrationPolicyChecksum(policy)
            || run.buildIdentityHash !== manifest.buildIdentityHash) fail();
          const revision = options.connection.prepare("SELECT build_identity_hash,migration_identity_hash,configuration_checksum FROM rollout_revisions WHERE project_id=$p AND revision_id=$r")
            .get({ $p: binding.projectId, $r: run.rolloutRevisionId });
          if (revision?.build_identity_hash !== manifest.buildIdentityHash || revision.migration_identity_hash !== migration
            || revision.configuration_checksum !== manifest.configurationChecksum) fail();
          return callback(tx);
        });
      };
      const initial = transact(tx => ({ receipts: tx.readImportedRecords(), outboxes: tx.readCompatibilityOutbox(),
        claims: tx.readCompatibilityClaims(), acknowledgements: tx.readCompatibilityAcknowledgements() }));
      // Production wrapper/source codecs and complete chain authentication also prove the zero-artifact case.
      const snapshot = await new V2ImportedProjectionEventReader({ driver: options.driver, eventStorePath: options.eventStorePath,
        sealedPackage: package_, sourceManifest: source.manifest }).openCommittedSnapshot(binding);
      snapshot.close(); checkConnection();
      const expected = manifest.recordDescriptors.filter(row => row.kind === "legacy-artifact");
      if (initial.receipts.length !== manifest.recordDescriptors.length || initial.outboxes.length !== expected.length) fail();
      const terminal = initial.receipts.at(-1)?.importedGlobalPosition ?? 0n;
      const events = new Map<string, StoredEvent>();
      replayCommittedProjectionEvents({ ...binding, branchScopeId: null, branchRef: null }, { driver: options.driver,
        eventStorePath: options.eventStorePath, terminalEventPosition: terminal, maxEvents: policy.maxEvents,
        maxAggregateBytes: policy.maxAggregateBytes }, event => {
        if (event.streamId === `v2-shadow-import/${migration}` && event.eventType === "V1LegacyArtifactImported") events.set(event.eventId, event);
      });
      const expectedClaims = new Map<string, CompatibilityClaim>(), expectedAcks = new Map<string, CompatibilityAcknowledgement>();
      const payloads = new Map<string, string>();
      const assertEvent = (event: StoredEvent) => {
        const row = options.connection.prepare("SELECT * FROM events WHERE global_position=$p").get({ $p: event.globalPosition });
        if (!row) fail();
        for (const [name, value] of Object.entries(event)) {
          if (name === "payload") continue;
          const array = ["sourceRefs", "evidenceRefs", "evidenceDigests"].includes(name);
          const column = name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`) + (array ? "_json" : "");
          if (array ? row[column] !== canonicalJson(value) : typeof value === "number" ? row[column] !== BigInt(value) : row[column] !== value) fail();
        }
      };
      for (const [index, descriptor] of expected.entries()) {
        const row = initial.outboxes[index]!, receipt = initial.receipts[descriptor.ordinal], event = events.get(row.importedEventId);
        if (!receipt || !event || row.sourceOrdinal !== descriptor.ordinal || receipt.sourceKind !== "legacy-artifact") fail();
        assertEvent(event);
        const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
        if (Object.keys(payload).sort().join(",") !== "contentSha256,contentUtf8,migrationIdentity,relativePath,schemaVersion,sourceOrdinal,sourceRecordHash"
          || payload.schemaVersion !== 1 || payload.migrationIdentity !== migration || payload.sourceOrdinal !== descriptor.ordinal
          || payload.sourceRecordHash !== descriptor.contentSha256 || payload.relativePath !== descriptor.relativePath
          || payload.contentSha256 !== descriptor.contentSha256 || typeof payload.contentUtf8 !== "string"
          || Buffer.byteLength(payload.contentUtf8, "utf8") !== descriptor.byteLength || hash(payload.contentUtf8) !== descriptor.contentSha256) fail();
        const id = deterministicMigrationUuid("claim", migration, descriptor.ordinal);
        const outbox: CompatibilityOutboxRecord = { projectId: binding.projectId, migrationIdentity: migration, outboxId: id,
          sourceOrdinal: descriptor.ordinal, importedEventId: receipt.importedEventId, importedGlobalPosition: receipt.importedGlobalPosition,
          importedEventHash: receipt.importedEventHash, triggeringPayloadHash: event.payloadHash, relativePath: descriptor.relativePath!,
          byteLength: descriptor.byteLength, contentSha256: descriptor.contentSha256, materializationRevision: BigInt(descriptor.ordinal + 1), recordedAt: receipt.recordedAt };
        if (!equal(row, outbox) || event.eventId !== receipt.importedEventId || event.globalPosition !== receipt.importedGlobalPosition
          || event.eventHash !== receipt.importedEventHash || receipt.sourceRecordHash !== descriptor.contentSha256) fail();
        resolveContainedProjectPath(options.isolatedRoot, row.relativePath);
        const time = (options.acknowledgementNow ?? clock)(source.manifest.createdAt, row.sourceOrdinal);
        if (time !== clock(source.manifest.createdAt, row.sourceOrdinal)) fail();
        expectedClaims.set(id, Object.freeze({ projectId: row.projectId, migrationIdentity: migration, outboxId: id,
          claimId: id, claimOwnerFingerprint: hash(`project-memory/v2-shadow-compatibility-owner/v1\n${migration}`), claimedAt: time }));
        const ack = { projectId: row.projectId, migrationIdentity: migration, outboxId: id, acknowledgementId: id, claimId: id,
          acknowledgedImportedPosition: row.importedGlobalPosition, materializationRevision: row.materializationRevision,
          targetContentSha256: row.contentSha256, acknowledgedAt: time };
        expectedAcks.set(id, Object.freeze({ ...ack, acknowledgementChecksum: hash(canonicalJson(decimal(ack))) }));
        payloads.set(id, payload.contentUtf8);
      }
      if (events.size !== expected.length) fail();
      const checkEvidence = (tx: V2ShadowMigrationTransaction, complete = false) => {
        if (!equal(tx.readImportedRecords(), initial.receipts) || !equal(tx.readCompatibilityOutbox(), initial.outboxes)) fail();
        const claims = tx.readCompatibilityClaims(), acks = tx.readCompatibilityAcknowledgements();
        for (const claim of claims) if (!equal(claim, expectedClaims.get(claim.outboxId))) fail();
        for (const ack of acks) if (!equal(ack, expectedAcks.get(ack.outboxId)) || !claims.some(claim => claim.outboxId === ack.outboxId)) fail();
        if (complete && (claims.length !== expected.length || acks.length !== expected.length)) fail();
        for (const event of events.values()) assertEvent(event);
      };
      transact(tx => checkEvidence(tx));
      for (const row of initial.outboxes) {
        const artifact = { relativePath: row.relativePath, byteLength: row.byteLength, contentSha256: row.contentSha256, remainingMs: remaining() };
        const priorClaim = initial.claims.some(claim => claim.outboxId === row.outboxId);
        const priorAck = initial.acknowledgements.some(ack => ack.outboxId === row.outboxId);
        if (!priorAck) { uncertain = true; transact(tx => { checkEvidence(tx); tx.claimCompatibility(expectedClaims.get(row.outboxId)!); }); }
        if (priorClaim || priorAck) await stable.verifyOnly(artifact);
        else {
          const parent = await stable.prepareParent(row.relativePath, remaining());
          const bytes = Buffer.from(payloads.get(row.outboxId)!, "utf8");
          try { await stable.publishOrReconcile({ ...artifact, parent, bytes, remainingMs: remaining() }); }
          finally { bytes.fill(0); }
        }
        if (!priorAck) transact(tx => { checkEvidence(tx); tx.acknowledgeCompatibility(expectedAcks.get(row.outboxId)!); });
        uncertain = false;
      }
      transact(tx => checkEvidence(tx, true));
      const last = initial.outboxes.at(-1);
      checkConnection();
      return Object.freeze({ schemaVersion: 1, migrationIdentity: migration, acknowledgedCount: initial.outboxes.length,
        highestAcknowledgedSourceOrdinal: last?.sourceOrdinal ?? null, acknowledgedImportedPosition: last?.importedGlobalPosition ?? null,
        materializationRevision: last?.materializationRevision ?? null, aggregateBytes: initial.outboxes.reduce((sum, row) => sum + row.byteLength, 0),
        artifactSetChecksum: hash(canonicalJson(initial.outboxes.map(row => ({ relativePathHash: hash(row.relativePath), byteLength: row.byteLength,
          contentSha256: row.contentSha256, materializationRevision: row.materializationRevision.toString() })))),
        deduplicated: initial.acknowledgements.length === initial.outboxes.length });
    } catch (error) {
      if (error instanceof ShadowMigrationError) throw new ShadowMigrationError(error.code);
      fail(uncertain);
    }
  }
}
