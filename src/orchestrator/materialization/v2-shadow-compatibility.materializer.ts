import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { StoredEvent } from "../contracts/event.js";
import { resolveContainedProjectPath } from "../identity/canonical-path.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { replayCommittedProjectionEvents } from "../projections/event-reader.js";
import type { SqliteConnection, SqliteDriver } from "../storage/sqlite-driver.js";
import { assertBoundSqliteConnectionIdentity } from "../storage/node-sqlite-driver.js";
import { SqliteV2ShadowMigrationRepository, type CompatibilityAcknowledgement, type CompatibilityClaim,
  type CompatibilityOutboxRecord, type V2ShadowMigrationTransaction } from "../storage/v2-shadow-migration.repository.js";
import type { VerifiedV1SourceCopy } from "../migration/v1-source-copy.js";
import type { SealedV2MigrationPackage } from "../migration/v2-migration-package.js";
import { V2ImportedProjectionEventReader } from "../migration/v2-imported-event-reader.js";
import { decodeShadowMigrationPolicyV1, deterministicMigrationUuid, shadowMigrationPolicyChecksum,
  ShadowMigrationError, type ShadowMigrationErrorCode, type ShadowMigrationPolicyV1 } from "../migration/v2-shadow-migration.contracts.js";
import { StableCompatibilityDirectory, captureCompatibilityPath } from "./stable-compatibility-directory.js";
import type { ShadowMigrationInvocationDeadline, ShadowMigrationReconciliation } from "../migration/v2-shadow-migration-runtime.js";

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
  readonly invocationDeadline?: ShadowMigrationInvocationDeadline;
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
  /** Internal runner fault boundaries; both occur after the named durable operation settles. */
  readonly fault?: (point: "after-compatibility-replace" | "after-compatibility-ack") => void | Promise<void>;
}
function fail(unknown = false): never { throw new ShadowMigrationError(unknown ? "MIGRATION_OUTCOME_UNKNOWN" : "COMPATIBILITY_INTEGRITY_FAILURE"); }
const SAFE_CODES: ReadonlySet<ShadowMigrationErrorCode> = new Set([
  "MIGRATION_POLICY_INVALID", "MIGRATION_SOURCE_INVALID", "MIGRATION_SOURCE_MUTATED", "MIGRATION_LIMIT_EXCEEDED",
  "MIGRATION_IDENTITY_CONFLICT", "MIGRATION_LEDGER_INTEGRITY_FAILURE", "MIGRATION_OUTCOME_UNKNOWN", "MIGRATION_RETRY_EXHAUSTED",
  "PROJECTION_INTEGRITY_FAILURE", "PARITY_RULE_INVALID", "PARITY_BLOCKING_DIVERGENCE", "COMPATIBILITY_INTEGRITY_FAILURE",
]);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function decimal(value: unknown, check: () => void = () => {}): unknown {
  check();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(entry => decimal(entry, check));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decimal(entry, check)]));
}
function overlap(a: string, b: string): boolean {
  const part = relative(a, b); return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}
const clock = (createdAt: string, ordinal: number) => new Date(Date.parse(createdAt) + ordinal).toISOString();

export class V2ShadowCompatibilityMaterializer {
  readonly #options: V2ShadowCompatibilityMaterializerOptions;
  constructor(options: V2ShadowCompatibilityMaterializerOptions) { this.#options = Object.freeze({ ...options }); }

  async materializePending(input: CompatibilityMaterializationInput): Promise<CompatibilityMaterializationResult> {
    const proof = await this.#execute(input, false);
    if (proof.status !== "committed") fail(true);
    return proof.result;
  }

  async reconcile(input: CompatibilityMaterializationInput): Promise<ShadowMigrationReconciliation<CompatibilityMaterializationResult>> {
    return this.#execute(input, true);
  }

  async #execute(input: CompatibilityMaterializationInput, readOnly: boolean): Promise<ShadowMigrationReconciliation<CompatibilityMaterializationResult>> {
    let possibleMutation = false;
    try {
      const options = this.#options, policy = decodeShadowMigrationPolicyV1(options.policy);
      const deadline = input.invocationDeadline;
      const now = options.operationNow ?? (() => performance.now()), start = deadline ? 0 : now();
      const remaining = () => {
        if (deadline) {
          if (deadline.signal.aborted) throw new ShadowMigrationError("MIGRATION_RETRY_EXHAUSTED");
          const value = deadline.remainingMs();
          if (!Number.isSafeInteger(value) || value < 1 || value > 300000) throw new ShadowMigrationError("MIGRATION_RETRY_EXHAUSTED");
          return value;
        }
        const elapsed = now() - start;
        if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= policy.deadlineMs) throw new ShadowMigrationError("MIGRATION_LIMIT_EXCEEDED");
        return Math.max(1, Math.floor(policy.deadlineMs - elapsed)); };
      const equal = (a: unknown, b: unknown) => canonicalJson(decimal(a, remaining)) === canonicalJson(decimal(b, remaining));
      remaining();
      const source = input.source, package_ = input.sealedPackage, manifest = package_.manifest, migration = package_.migrationIdentity;
      const binding = source.projectionSnapshot.binding;
      source.assertUnchanged(); package_.assertUnchanged();
      const targetIdentity = captureCompatibilityPath(options.eventStorePath, false);
      const forbiddenRoots = [options.liveVaultRoot, dirname(options.liveEventStorePath), source.sourceRoot, package_.rootPath];
      const stable = new StableCompatibilityDirectory({ rootPath: options.isolatedRoot, forbiddenRoots });
      const isolatedIdentity = captureCompatibilityPath(options.isolatedRoot, true);
      const protectedIdentities = forbiddenRoots.map(path => { remaining(); return captureCompatibilityPath(path, true); });
      if (overlap(options.isolatedRoot, options.eventStorePath) || overlap(options.eventStorePath, options.isolatedRoot)) fail();
      const liveIdentity = captureCompatibilityPath(options.liveEventStorePath, false);
      const sameIdentity = (a: typeof targetIdentity, b: typeof targetIdentity) => a.device === b.device && a.inode === b.inode;
      if (sameIdentity(targetIdentity, liveIdentity)) fail();
      for (const protectedRoot of forbiddenRoots) { remaining(); if (overlap(protectedRoot, options.eventStorePath)) fail(); }
      const checkConnection = () => {
        remaining(); source.assertUnchanged(); package_.assertUnchanged();
        assertBoundSqliteConnectionIdentity(options.connection, options.eventStorePath, targetIdentity);
        if (!sameIdentity(targetIdentity, captureCompatibilityPath(options.eventStorePath, false))) fail();
        if (!sameIdentity(isolatedIdentity, captureCompatibilityPath(options.isolatedRoot, true))
          || !sameIdentity(liveIdentity, captureCompatibilityPath(options.liveEventStorePath, false))) fail();
        for (const [index, root] of forbiddenRoots.entries()) {
          remaining(); if (!sameIdentity(protectedIdentities[index]!, captureCompatibilityPath(root, true))) fail();
        }
        const database = options.connection.prepare("PRAGMA database_list").all().find(row => row.name === "main");
        if (typeof database?.file !== "string" || !sameIdentity(targetIdentity, captureCompatibilityPath(database.file, false))) fail();
        remaining();
      };
      checkConnection();
      // The repository's only authority is the identity-verified target connection.
      const repository = new SqliteV2ShadowMigrationRepository(options.connection);
      const transact = <T>(callback: (tx: V2ShadowMigrationTransaction) => T, mutation = false): T => {
        checkConnection();
        const result = repository.transact(binding.projectId, migration, tx => {
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
          remaining();
          const value = callback(tx);
          checkConnection();
          // A callback failure rolls back. Once COMMIT may be attempted, losing its response is uncertain.
          if (mutation) possibleMutation = true;
          return value;
        });
        checkConnection();
        return result;
      };
      const initial = transact(tx => ({ receipts: tx.readImportedRecords(), outboxes: tx.readCompatibilityOutbox(),
        claims: tx.readCompatibilityClaims(), acknowledgements: tx.readCompatibilityAcknowledgements() }));
      // Production wrapper/source codecs and complete chain authentication also prove the zero-artifact case.
      const snapshot = await new V2ImportedProjectionEventReader({ driver: options.driver, eventStorePath: options.eventStorePath,
        sealedPackage: package_, sourceManifest: source.manifest, busyTimeoutMs: Math.min(5000, remaining()) }).openCommittedSnapshot(binding);
      let snapshotFailure = false;
      try { checkConnection(); }
      catch (error) { snapshotFailure = true; throw error; }
      finally { try { snapshot.close(); } catch (error) { if (!snapshotFailure) throw error; } }
      checkConnection();
      const expected = manifest.recordDescriptors.filter(row => { remaining(); return row.kind === "legacy-artifact"; });
      if (initial.receipts.length !== manifest.recordDescriptors.length || initial.outboxes.length !== expected.length) fail();
      const terminal = initial.receipts.at(-1)?.importedGlobalPosition ?? 0n;
      const events = new Map<string, StoredEvent>();
      replayCommittedProjectionEvents({ ...binding, branchScopeId: null, branchRef: null }, { driver: options.driver,
        eventStorePath: options.eventStorePath, terminalEventPosition: terminal, maxEvents: policy.maxEvents,
        maxAggregateBytes: policy.maxAggregateBytes, busyTimeoutMs: Math.min(5000, remaining()) }, event => {
        remaining();
        if (event.streamId === `v2-shadow-import/${migration}` && event.eventType === "V1LegacyArtifactImported") events.set(event.eventId, event);
      });
      const expectedClaims = new Map<string, CompatibilityClaim>(), expectedAcks = new Map<string, CompatibilityAcknowledgement>();
      const payloads = new Map<string, string>();
      const assertEvent = (event: StoredEvent) => {
        remaining();
        const row = options.connection.prepare("SELECT * FROM events WHERE global_position=$p").get({ $p: event.globalPosition });
        if (!row) fail();
        for (const [name, value] of Object.entries(event)) {
          remaining();
          if (name === "payload") continue;
          const array = ["sourceRefs", "evidenceRefs", "evidenceDigests"].includes(name);
          const column = name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`) + (array ? "_json" : "");
          if (array ? row[column] !== canonicalJson(value) : typeof value === "number" ? row[column] !== BigInt(value) : row[column] !== value) fail();
        }
      };
      for (const [index, descriptor] of expected.entries()) {
        checkConnection();
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
        expectedAcks.set(id, Object.freeze({ ...ack, acknowledgementChecksum: hash(canonicalJson(decimal(ack, remaining))) }));
        payloads.set(id, payload.contentUtf8);
      }
      if (events.size !== expected.length) fail();
      const checkEvidence = (tx: V2ShadowMigrationTransaction, complete = false) => {
        if (!equal(tx.readImportedRecords(), initial.receipts) || !equal(tx.readCompatibilityOutbox(), initial.outboxes)) fail();
        const claims = tx.readCompatibilityClaims(), acks = tx.readCompatibilityAcknowledgements();
        const claimIds = new Set(claims.map(claim => { remaining(); return claim.outboxId; }));
        for (const claim of claims) if (!equal(claim, expectedClaims.get(claim.outboxId))) fail();
        for (const ack of acks) if (!equal(ack, expectedAcks.get(ack.outboxId)) || !claimIds.has(ack.outboxId)) fail();
        if (complete && (claims.length !== expected.length || acks.length !== expected.length)) fail();
        for (const event of events.values()) assertEvent(event);
        return { claims, acks };
      };
      const evidence = transact(tx => checkEvidence(tx));
      const initialClaimIds = new Set(evidence.claims.map(claim => { remaining(); return claim.outboxId; }));
      const initialAcknowledgementIds = new Set(evidence.acks.map(ack => { remaining(); return ack.outboxId; }));
      if (readOnly && expected.length > 0 && (evidence.claims.length !== expected.length || evidence.acks.length !== expected.length)) {
        // A single checked transaction proves absence. Any authenticated partial state needs a later normal invocation.
        const absent = evidence.claims.length === 0 && evidence.acks.length === 0;
        checkConnection();
        return absent ? Object.freeze({ status: "absent" })
          : Object.freeze({ status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });
      }
      for (const row of initial.outboxes) {
        checkConnection();
        const artifact = { relativePath: row.relativePath, byteLength: row.byteLength, contentSha256: row.contentSha256 };
        const priorClaim = initialClaimIds.has(row.outboxId);
        const priorAck = initialAcknowledgementIds.has(row.outboxId);
        if (!readOnly && !priorClaim) transact(tx => { checkEvidence(tx); remaining(); tx.claimCompatibility(expectedClaims.get(row.outboxId)!); }, true);
        if (readOnly || priorClaim || priorAck) await stable.verifyOnly({ ...artifact, remainingMs: remaining() });
        else {
          const parent = await stable.prepareParent(row.relativePath, remaining());
          checkConnection();
          const bytes = Buffer.from(payloads.get(row.outboxId)!, "utf8");
          try { await stable.publishOrReconcile({ ...artifact, parent, bytes, remainingMs: remaining() }); }
          finally { bytes.fill(0); }
        }
        checkConnection();
        if (!readOnly && !priorAck) {
          await options.fault?.("after-compatibility-replace");
          checkConnection();
          transact(tx => { checkEvidence(tx); remaining(); tx.acknowledgeCompatibility(expectedAcks.get(row.outboxId)!); }, true);
          await options.fault?.("after-compatibility-ack");
          checkConnection();
        }
      }
      transact(tx => checkEvidence(tx, true));
      const last = initial.outboxes.at(-1);
      checkConnection();
      const result: CompatibilityMaterializationResult = Object.freeze({ schemaVersion: 1, migrationIdentity: migration, acknowledgedCount: initial.outboxes.length,
        highestAcknowledgedSourceOrdinal: last?.sourceOrdinal ?? null, acknowledgedImportedPosition: last?.importedGlobalPosition ?? null,
        materializationRevision: last?.materializationRevision ?? null, aggregateBytes: initial.outboxes.reduce((sum, row) => { remaining(); return sum + row.byteLength; }, 0),
        artifactSetChecksum: hash(canonicalJson(initial.outboxes.map(row => { remaining(); return { relativePathHash: hash(row.relativePath), byteLength: row.byteLength,
          contentSha256: row.contentSha256, materializationRevision: row.materializationRevision.toString() }; }))),
        deduplicated: evidence.acks.length === initial.outboxes.length });
      checkConnection();
      return Object.freeze({ status: "committed", result });
    } catch (error) {
      if (error instanceof ShadowMigrationError && SAFE_CODES.has(error.code)) {
        if (possibleMutation && (error.code === "MIGRATION_RETRY_EXHAUSTED" || error.code === "MIGRATION_LIMIT_EXCEEDED")) fail(true);
        if (readOnly && error.code === "MIGRATION_OUTCOME_UNKNOWN") return Object.freeze({ status: "unknown", safeErrorCode: error.code });
        throw new ShadowMigrationError(error.code);
      }
      if (readOnly) return Object.freeze({ status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });
      fail(possibleMutation);
    }
  }
}
