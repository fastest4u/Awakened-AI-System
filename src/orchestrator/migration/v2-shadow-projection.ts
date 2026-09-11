import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { LifecycleError } from "../lifecycle/errors.js";
import { ImmutableProjectionBuilder, type BuiltProjectionGeneration } from "../projections/builder.js";
import { V2ProjectionBuildCoordinator, type PublishedProjectionGenerationV2 } from "../projections/coordinator.js";
import { ProjectionIntegrityService } from "../projections/integrity.js";
import { type ProjectionManifestV1, parseProjectionManifest, publishProjectionManifest, acquireProjectionManifestPublicationLease } from "../projections/manifest.js";
import { captureProjectionDirectoryIdentity, filesystemStableProjectionDirectoryOperations, sameProjectionDirectoryIdentity } from "../projections/stable-directory.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { EventStoreError } from "../storage/event-store.js";
import { isPrimarySqliteBusy } from "../storage/event-append-transaction.js";
import type { SqliteConnection, SqliteDriver } from "../storage/sqlite-driver.js";
import { SqliteV2ShadowMigrationRepository } from "../storage/v2-shadow-migration.repository.js";
import { decodeV1SourceCopyManifestV1, type VerifiedV1SourceCopy } from "./v1-source-copy.js";
import type { SealedV2MigrationPackage } from "./v2-migration-package.js";
import { V2ImportedProjectionEventReader } from "./v2-imported-event-reader.js";
import { decodeShadowMigrationPolicyV1, shadowMigrationPolicyChecksum, ShadowMigrationError, type ShadowMigrationPolicyV1, type ShadowMigrationErrorCode } from "./v2-shadow-migration.contracts.js";

export interface PreparedV1ProjectionBaseline {
  readonly generation: BuiltProjectionGeneration;
  readonly baselineChecksum: string;
  readonly sourceManifestChecksum: string;
  readonly terminalEventPosition: string;
  readonly terminalEventHash: string;
}
export interface ShadowProjectionResult {
  readonly v1: PreparedV1ProjectionBaseline;
  readonly v2: PublishedProjectionGenerationV2;
  readonly v1BaselineChecksum: string;
  readonly v2ManifestChecksum: string;
}
export interface V1ProjectionBaselineInput {
  readonly source: VerifiedV1SourceCopy;
  readonly sealedPackage: SealedV2MigrationPackage;
}
export interface ShadowProjectionInput extends V1ProjectionBaselineInput {
  readonly preparedV1: PreparedV1ProjectionBaseline;
  readonly rolloutRevisionId: string;
}
export interface V2ShadowProjectionPublisherOptions {
  readonly driver: SqliteDriver;
  readonly connection: SqliteConnection;
  readonly eventStorePath: string;
  readonly liveEventStorePath: string;
  readonly liveVaultRoot: string;
  readonly v1ProjectionDirectory: string;
  readonly v2ProjectionDirectory: string;
  readonly policy: ShadowMigrationPolicyV1;
  readonly operationNow?: () => number;
  readonly faultInjector?: Readonly<{ hit(boundary: "before-v2-integrity" | "before-v1-manifest", databasePath: string): void }>;
}
const BINDING_FIELDS = ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef"] as const;
const SAFE_CODES: ReadonlySet<ShadowMigrationErrorCode> = new Set([
  "MIGRATION_POLICY_INVALID", "MIGRATION_SOURCE_INVALID", "MIGRATION_SOURCE_MUTATED", "MIGRATION_LIMIT_EXCEEDED",
  "MIGRATION_IDENTITY_CONFLICT", "MIGRATION_LEDGER_INTEGRITY_FAILURE", "MIGRATION_OUTCOME_UNKNOWN", "MIGRATION_RETRY_EXHAUSTED",
  "PROJECTION_INTEGRITY_FAILURE", "PARITY_RULE_INVALID", "PARITY_BLOCKING_DIVERGENCE", "COMPATIBILITY_INTEGRITY_FAILURE",
]);
const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
function failure(code: ShadowMigrationErrorCode = "PROJECTION_INTEGRITY_FAILURE"): never { throw new ShadowMigrationError(code); }
function safeFailure(error: unknown): Error {
  try {
    if (error instanceof ShadowMigrationError && SAFE_CODES.has(error.code)) return new ShadowMigrationError(error.code);
    if ((error instanceof EventStoreError && error.code === "SQLITE_BUSY") || isPrimarySqliteBusy(error)) return new EventStoreError("SQLITE_BUSY", { retryable: true });
    if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") return new ShadowMigrationError("PROJECTION_INTEGRITY_FAILURE");
  } catch { /* untrusted error metadata */ }
  return new ShadowMigrationError("MIGRATION_LEDGER_INTEGRITY_FAILURE");
}

export function v1ProjectionBaselineChecksum(manifest: ProjectionManifestV1): string {
  return hash(`project-memory/v1-shadow-baseline/v1\n${canonicalJson({
    projectId: manifest.projectId, vaultId: manifest.vaultId, storeId: manifest.storeId, workspaceId: manifest.workspaceId,
    branchScopeId: manifest.branchScopeId, branchRef: manifest.branchRef, terminalEventPosition: manifest.terminalEventPosition,
    terminalEventHash: manifest.terminalEventHash, coreChecksums: manifest.coreChecksums,
  })}`);
}

function pathIdentity(path: string, directory: boolean) {
  const key = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (!isAbsolute(path) || normalize(path) !== path || key(realpathSync.native(path)) !== key(path)) failure();
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) failure();
  return stat;
}
function overlaps(left: string, right: string): boolean {
  const child = relative(left, right);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

/** Internal rehearsal publisher. Neither generation is registered for caller routing. */
export class V2ShadowProjectionPublisher {
  readonly #options: V2ShadowProjectionPublisherOptions;
  constructor(options: V2ShadowProjectionPublisherOptions) {
    this.#options = Object.freeze({ ...options, policy: decodeShadowMigrationPolicyV1(options.policy) });
  }

  #validate(input: V1ProjectionBaselineInput): void {
    input.source.assertUnchanged(); input.sealedPackage.assertUnchanged();
    const source = decodeV1SourceCopyManifestV1(input.source.manifest);
    const manifest = input.sealedPackage.manifest;
    if (source.manifestChecksum !== manifest.sourceManifestChecksum || source.createdAt !== manifest.createdAt
      || source.terminalEventPosition !== manifest.terminalEventPosition || source.terminalEventHash !== manifest.terminalEventHash
      || source.eventCount !== manifest.eventCount || source.aggregateSourceBytes !== manifest.aggregateSourceBytes
      || BINDING_FIELDS.some(key => input.source.projectionSnapshot.binding[key] !== source[key])
      || ["projectId", "vaultId", "storeId", "workspaceId"].some(key => source[key as "projectId"] !== manifest[key as "projectId"])) failure();
    const roots = [this.#options.v1ProjectionDirectory, this.#options.v2ProjectionDirectory];
    const identities = roots.map(path => pathIdentity(path, true));
    if (identities[0]!.dev === identities[1]!.dev && identities[0]!.ino === identities[1]!.ino) failure();
    for (const root of roots) {
      for (const protectedRoot of [input.source.sourceRoot, input.sealedPackage.rootPath, this.#options.liveVaultRoot, dirname(this.#options.liveEventStorePath)]) {
        const protectedIdentity = pathIdentity(protectedRoot, true);
        const rootIdentity = pathIdentity(root, true);
        if (protectedIdentity.dev === rootIdentity.dev && protectedIdentity.ino === rootIdentity.ino) failure();
        if (overlaps(root, protectedRoot) || overlaps(protectedRoot, root)) failure();
      }
    }
    if (overlaps(roots[0]!, roots[1]!) || overlaps(roots[1]!, roots[0]!)) failure();
  }

  #integrity(directory: string): ProjectionIntegrityService {
    return new ProjectionIntegrityService({ driver: this.#options.driver, eventStorePath: this.#options.eventStorePath,
      projectionDirectory: directory, maxReplayEvents: this.#options.policy.maxEvents, maxReplayBytes: this.#options.policy.maxAggregateBytes });
  }

  async prepareV1Baseline(input: V1ProjectionBaselineInput): Promise<PreparedV1ProjectionBaseline> {
    try {
      this.#validate(input);
      const directory = this.#options.v1ProjectionDirectory;
      const lease = acquireProjectionManifestPublicationLease(directory);
      try {
        const captured = filesystemStableProjectionDirectoryOperations.captureManifest(directory, lease.directoryIdentity);
        let generation: BuiltProjectionGeneration;
        if (captured.state === "present") {
          const manifest = parseProjectionManifest(JSON.parse(Buffer.from(captured.bytesBase64, "base64").toString("utf8")), input.source.projectionSnapshot.binding);
          generation = Object.freeze({ manifest, projectionDirectory: directory, databasePath: join(directory, manifest.databaseFile) });
        } else if (existsSync(join(directory, "projections-1-1.sqlite"))) {
          generation = this.#integrity(directory).recoverV1Generation(input.source.projectionSnapshot, input.sealedPackage.manifest.createdAt);
        } else {
          generation = await new ImmutableProjectionBuilder({ driver: this.#options.driver, projectionDirectory: directory,
            now: () => input.sealedPackage.manifest.createdAt }).build(input.source.projectionSnapshot, 1);
        }
        this.#integrity(directory).verifyV1Generation(input.source.projectionSnapshot, generation);
        if (generation.manifest.generation !== 1 || generation.manifest.createdAt !== input.sealedPackage.manifest.createdAt) failure();
        input.source.assertUnchanged(); input.sealedPackage.assertUnchanged();
        if (!sameProjectionDirectoryIdentity(lease.directoryIdentity, captureProjectionDirectoryIdentity(directory))) failure();
        if (captured.state === "missing") {
          this.#options.faultInjector?.hit("before-v1-manifest", generation.databasePath);
          input.source.assertUnchanged(); input.sealedPackage.assertUnchanged();
          this.#integrity(directory).verifyV1Generation(input.source.projectionSnapshot, generation);
          publishProjectionManifest({ projectionDirectory: directory, manifest: generation.manifest,
            expectedBinding: input.source.projectionSnapshot.binding });
        }
        return Object.freeze({ generation, baselineChecksum: v1ProjectionBaselineChecksum(generation.manifest),
          sourceManifestChecksum: input.source.manifest.manifestChecksum, terminalEventPosition: generation.manifest.terminalEventPosition,
          terminalEventHash: generation.manifest.terminalEventHash });
      } finally { lease.release(); }
    } catch (error) { throw safeFailure(error); }
  }

  async publishV2(input: ShadowProjectionInput): Promise<ShadowProjectionResult> {
    try {
      const now = this.#options.operationNow ?? (() => performance.now());
      const start = now();
      const remaining = () => { const elapsed = now() - start; if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= this.#options.policy.deadlineMs) failure("MIGRATION_LIMIT_EXCEEDED"); return Math.floor(this.#options.policy.deadlineMs - elapsed); };
      this.#validate(input);
      const target = pathIdentity(this.#options.eventStorePath, false);
      for (const protectedRoot of [input.source.sourceRoot, input.sealedPackage.rootPath, this.#options.liveVaultRoot,
        dirname(this.#options.liveEventStorePath), this.#options.v1ProjectionDirectory, this.#options.v2ProjectionDirectory]) {
        if (overlaps(protectedRoot, this.#options.eventStorePath)) failure();
      }
      const sourceFile = pathIdentity(join(input.source.sourceRoot, input.source.manifest.database.relativePath), false);
      if (target.dev === sourceFile.dev && target.ino === sourceFile.ino) failure();
      const live = pathIdentity(this.#options.liveEventStorePath, false);
      const database = this.#options.connection.prepare("PRAGMA database_list").all().find(row => row.name === "main");
      if (typeof database?.file !== "string") failure();
      const connected = pathIdentity(database.file, false);
      if (target.dev !== connected.dev || target.ino !== connected.ino || (target.dev === live.dev && target.ino === live.ino)) failure();
      // Transaction authority comes only from the connection authenticated above.
      const repository = new SqliteV2ShadowMigrationRepository(this.#options.connection);
      const prepared = input.preparedV1;
      const binding = input.source.projectionSnapshot.binding;
      const manifest = input.sealedPackage.manifest;
      const baseline = v1ProjectionBaselineChecksum(prepared.generation.manifest);
      if (prepared.sourceManifestChecksum !== manifest.sourceManifestChecksum || prepared.terminalEventPosition !== manifest.terminalEventPosition
        || prepared.terminalEventHash !== manifest.terminalEventHash || baseline !== prepared.baselineChecksum) failure();
      const adopted = await this.prepareV1Baseline(input);
      if (canonicalJson(adopted) !== canonicalJson(prepared)) failure();
      const checkRun = () => repository.transact(binding.projectId, input.sealedPackage.migrationIdentity, tx => {
        const run = tx.readRun();
        if (!run || run.rolloutRevisionId !== input.rolloutRevisionId || run.packageChecksum !== manifest.packageChecksum
          || run.sourceManifestChecksum !== manifest.sourceManifestChecksum || run.sourceTerminalHash !== manifest.terminalEventHash
          || run.sourceTerminalPosition !== BigInt(manifest.terminalEventPosition) || run.configurationChecksum !== manifest.configurationChecksum
          || run.buildIdentityHash !== manifest.buildIdentityHash || run.policyChecksum !== shadowMigrationPolicyChecksum(this.#options.policy)) failure();
        const revision = this.#options.connection.prepare("SELECT v1_baseline_checksum,build_identity_hash,migration_identity_hash,configuration_checksum FROM rollout_revisions WHERE project_id=$p AND revision_id=$r")
          .get({ $p: binding.projectId, $r: run.rolloutRevisionId });
        if (revision?.v1_baseline_checksum !== baseline || revision.build_identity_hash !== manifest.buildIdentityHash
          || revision.migration_identity_hash !== input.sealedPackage.migrationIdentity
          || revision.configuration_checksum !== manifest.configurationChecksum) failure();
        const phases = tx.readTransitions();
        if (phases.length < 3 || phases[2]!.phase !== "import-committed") failure();
      });
      checkRun();
      const reader = new V2ImportedProjectionEventReader({ driver: this.#options.driver, eventStorePath: this.#options.eventStorePath,
        sealedPackage: input.sealedPackage, sourceManifest: input.source.manifest });
      const v2 = await new V2ProjectionBuildCoordinator({ eventReader: reader, projectionDirectory: this.#options.v2ProjectionDirectory,
        builder: new ImmutableProjectionBuilder({ driver: this.#options.driver, projectionDirectory: this.#options.v2ProjectionDirectory,
          now: () => manifest.createdAt }), now }).ensurePublished(binding, BigInt(manifest.terminalEventPosition), remaining());
      if (v2.manifest.terminalEventPosition !== manifest.terminalEventPosition || v2.manifest.terminalEventHash !== manifest.terminalEventHash
        || BINDING_FIELDS.some(key => v2.manifest[key] !== binding[key]) || v2.manifest.createdAt !== manifest.createdAt) failure();
      this.#options.faultInjector?.hit("before-v2-integrity", v2.databasePath);
      const snapshot = await reader.openCommittedSnapshot(binding);
      try { this.#integrity(this.#options.v2ProjectionDirectory).verifyCommittedSnapshot(binding, v2.manifest, snapshot); }
      finally { snapshot.close(); }
      if (canonicalJson(await this.prepareV1Baseline(input)) !== canonicalJson(prepared)) failure();
      input.source.assertUnchanged(); input.sealedPackage.assertUnchanged(); remaining(); checkRun();
      const v2ManifestChecksum = hash(canonicalJson(v2.manifest));
      const evidenceDigest = hash(canonicalJson({ v1ManifestChecksum: hash(canonicalJson(prepared.generation.manifest)), v2ManifestChecksum, v1BaselineChecksum: baseline }));
      repository.transact(binding.projectId, input.sealedPackage.migrationIdentity, tx => {
        const phases = tx.readTransitions();
        if (phases[3]) { if (phases[3].phase !== "projection-verified" || phases[3].evidenceDigest !== evidenceDigest) failure(); return; }
        if (phases.length !== 3) failure();
        const body = { projectId: binding.projectId, migrationIdentity: input.sealedPackage.migrationIdentity, ordinal: 3,
          attemptId: randomUUID(), phase: "projection-verified" as const, priorTransitionHash: phases[2]!.transitionHash, evidenceDigest, recordedAt: manifest.createdAt };
        tx.appendTransition({ ...body, transitionHash: hash(`project-memory/v2-shadow-migration-transition/v1\n${canonicalJson(body)}`) });
      });
      return Object.freeze({ v1: prepared, v2, v1BaselineChecksum: baseline, v2ManifestChecksum });
    } catch (error) { throw safeFailure(error); }
  }
}
