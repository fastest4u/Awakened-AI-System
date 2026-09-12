import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { LifecycleError } from "../lifecycle/errors.js";
import { ImmutableProjectionBuilder, type BuiltProjectionGeneration } from "../projections/builder.js";
import { V2ProjectionBuildCoordinator, type PublishedProjectionGenerationV2 } from "../projections/coordinator.js";
import { ProjectionIntegrityService } from "../projections/integrity.js";
import { type ProjectionManifestV1, parseProjectionManifest, parseProjectionManifestV2, publishProjectionManifest, acquireProjectionManifestPublicationLease } from "../projections/manifest.js";
import { captureProjectionDirectoryIdentity, filesystemStableProjectionDirectoryOperations, sameProjectionDirectoryIdentity, type ProjectionDirectoryIdentity } from "../projections/stable-directory.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { EventStoreError } from "../storage/event-store.js";
import { isPrimarySqliteBusy } from "../storage/event-append-transaction.js";
import type { SqliteConnection, SqliteDriver } from "../storage/sqlite-driver.js";
import { assertBoundSqliteConnectionIdentity } from "../storage/node-sqlite-driver.js";
import type { ProjectionEventSnapshot } from "../projections/event-reader.js";
import { SqliteV2ShadowMigrationRepository } from "../storage/v2-shadow-migration.repository.js";
import { decodeV1SourceCopyManifestV1, type VerifiedV1SourceCopy } from "./v1-source-copy.js";
import type { SealedV2MigrationPackage } from "./v2-migration-package.js";
import { V2ImportedProjectionEventReader } from "./v2-imported-event-reader.js";
import { decodeShadowMigrationPolicyV1, shadowMigrationPolicyChecksum, ShadowMigrationError, type ShadowMigrationPolicyV1, type ShadowMigrationErrorCode } from "./v2-shadow-migration.contracts.js";
import { shadowMigrationPhaseMetadata, type ShadowMigrationInvocationDeadline, type ShadowMigrationReconciliation } from "./v2-shadow-migration-runtime.js";

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
  readonly invocationDeadline?: ShadowMigrationInvocationDeadline;
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

function existingIdentity(path: string, directory: boolean) {
  try { lstatSync(path); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      if (!isAbsolute(path) || normalize(path) !== path) failure();
      pathIdentity(dirname(path), true);
      return undefined;
    }
    throw error;
  }
  return pathIdentity(path, directory);
}

function unknownProof(safeErrorCode: ShadowMigrationErrorCode = "MIGRATION_OUTCOME_UNKNOWN") {
  return Object.freeze({ status: "unknown" as const, safeErrorCode });
}

interface ProjectionOperation {
  remaining(): number;
  check(): void;
  mayHavePublished: boolean;
  primaryFailure?: unknown;
}

async function owned<T>(close: () => void, action: () => Promise<T>): Promise<T> {
  let primary: { error: unknown } | undefined;
  try { return await action(); }
  catch (error) { primary = { error }; throw error; }
  finally { try { close(); } catch (error) { if (!primary) throw error; } }
}

function guardedSnapshot(snapshot: ProjectionEventSnapshot, operation: ProjectionOperation): ProjectionEventSnapshot {
  return Object.freeze({ ...snapshot,
    events: function* () {
      try {
        operation.check();
        for (const event of snapshot.events()) { operation.check(); yield event; operation.check(); }
        operation.check();
      } catch (error) { operation.primaryFailure ??= error; throw error; }
    },
    close() { try { snapshot.close(); } catch (error) { if (!operation.primaryFailure) throw error; } },
  });
}

function observeV1Image(path: string, directory: ProjectionDirectoryIdentity, operation: ProjectionOperation) {
  operation.check();
  if (path !== join(directory.canonicalPath, "projections-1-1.sqlite")) failure();
  const parent = pathIdentity(directory.canonicalPath, true);
  if (String(parent.dev) !== directory.device || String(parent.ino) !== directory.inode) failure();
  const initial = pathIdentity(path, false);
  if (initial.size < 1n || initial.size > 128n * 1024n * 1024n) failure();
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let primary: { error: unknown } | undefined;
  const identity = (stat: typeof initial) => ({ device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), ctimeNs: String(stat.ctimeNs) });
  const check = () => {
    operation.check();
    const opened = fstatSync(descriptor, { bigint: true });
    if (canonicalJson(identity(pathIdentity(directory.canonicalPath, true))) !== canonicalJson(identity(parent))
      || !opened.isFile() || opened.nlink !== 1n || canonicalJson(identity(opened)) !== canonicalJson(identity(initial))
      || canonicalJson(identity(pathIdentity(path, false))) !== canonicalJson(identity(initial))) failure();
    operation.check();
  };
  try {
    check();
    const digest = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < Number(initial.size)) {
      operation.check();
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, Number(initial.size) - offset), offset);
      operation.check(); if (count < 1) failure();
      digest.update(buffer.subarray(0, count)); offset += count;
    }
    check();
    return Object.freeze({ ...identity(initial), sha256: digest.digest("hex") });
  } catch (error) { primary = { error }; throw error; }
  finally { try { closeSync(descriptor); } catch (error) { if (!primary) throw error; } }
}

/** Internal rehearsal publisher. Neither generation is registered for caller routing. */
export class V2ShadowProjectionPublisher {
  readonly #options: V2ShadowProjectionPublisherOptions;
  constructor(options: V2ShadowProjectionPublisherOptions) {
    this.#options = Object.freeze({ ...options, policy: decodeShadowMigrationPolicyV1(options.policy) });
  }

  async #execute<I extends V1ProjectionBaselineInput, T>(value: I, action: (input: I, operation: ProjectionOperation) => Promise<T>, proof = false): Promise<T> {
    // Capture retained invocation authority once, including when the caller uses an accessor.
    const input = Object.freeze({ ...value });
    const deadline = input.invocationDeadline;
    const now = this.#options.operationNow ?? (() => performance.now());
    const start = deadline ? 0 : now();
    let previous = start;
    const operation: ProjectionOperation = {
      mayHavePublished: false,
      remaining: () => {
        try {
          if (deadline) {
            const remaining = deadline.remainingMs();
            if (deadline.signal.aborted || !Number.isSafeInteger(remaining) || remaining < 1) failure("MIGRATION_RETRY_EXHAUSTED");
            return remaining;
          }
          const current = now(); const remaining = Math.floor(this.#options.policy.deadlineMs - (current - start));
          if (!Number.isFinite(current) || current < previous || !Number.isSafeInteger(remaining) || remaining < 1) failure("MIGRATION_LIMIT_EXCEEDED");
          previous = current; return remaining;
        } catch (error) { operation.primaryFailure ??= error; throw error; }
      },
      check: () => {
        try {
          operation.remaining();
          if (deadline || proof) this.#assertBoundTarget();
          operation.remaining();
        } catch (error) { operation.primaryFailure ??= error; throw error; }
      },
    };
    try {
      operation.check();
      const result = await action(input, operation);
      this.#unchanged(input, operation);
      return result;
    } catch (error) {
      const primary = operation.primaryFailure ?? error;
      if (proof) {
        // A typed authority/contradiction refusal keeps its classification. An
        // uncertain read must still spend the same budget and recheck authority.
        if (!(primary instanceof ShadowMigrationError) || primary.code === "MIGRATION_OUTCOME_UNKNOWN") this.#unchanged(input, operation);
        throw primary;
      }
      if (operation.mayHavePublished && primary instanceof ShadowMigrationError
        && ["MIGRATION_LIMIT_EXCEEDED", "MIGRATION_RETRY_EXHAUSTED"].includes(primary.code)) failure("MIGRATION_OUTCOME_UNKNOWN");
      if (operation.mayHavePublished && !(primary instanceof ShadowMigrationError)
        && !(primary instanceof LifecycleError && primary.code === "INTEGRITY_FAILURE")) failure("MIGRATION_OUTCOME_UNKNOWN");
      throw safeFailure(primary);
    }
  }

  #assertBoundTarget(): void {
    try {
      const target = pathIdentity(this.#options.eventStorePath, false);
      assertBoundSqliteConnectionIdentity(this.#options.connection, this.#options.eventStorePath,
        { device: String(target.dev), inode: String(target.ino) });
    } catch { failure("MIGRATION_IDENTITY_CONFLICT"); }
  }

  #unchanged(input: V1ProjectionBaselineInput, operation: ProjectionOperation): void {
    operation.check(); input.source.assertUnchanged(); operation.check(); input.sealedPackage.assertUnchanged(); operation.check();
  }

  #validate(input: V1ProjectionBaselineInput, operation: ProjectionOperation, proof = false): void {
    this.#unchanged(input, operation);
    const source = decodeV1SourceCopyManifestV1(input.source.manifest);
    const manifest = input.sealedPackage.manifest;
    if (source.manifestChecksum !== manifest.sourceManifestChecksum || source.createdAt !== manifest.createdAt
      || source.terminalEventPosition !== manifest.terminalEventPosition || source.terminalEventHash !== manifest.terminalEventHash
      || source.eventCount !== manifest.eventCount || source.aggregateSourceBytes !== manifest.aggregateSourceBytes
      || BINDING_FIELDS.some(key => input.source.projectionSnapshot.binding[key] !== source[key])
      || ["projectId", "vaultId", "storeId", "workspaceId"].some(key => source[key as "projectId"] !== manifest[key as "projectId"])) failure();
    const roots = [this.#options.v1ProjectionDirectory, this.#options.v2ProjectionDirectory];
    const identities = roots.map(path => proof ? existingIdentity(path, true) : pathIdentity(path, true));
    if (identities[0] && identities[1] && identities[0].dev === identities[1].dev && identities[0].ino === identities[1].ino) failure();
    for (const root of roots) {
      for (const protectedRoot of [input.source.sourceRoot, input.sealedPackage.rootPath, this.#options.liveVaultRoot, dirname(this.#options.liveEventStorePath)]) {
        const protectedIdentity = pathIdentity(protectedRoot, true);
        const rootIdentity = proof ? existingIdentity(root, true) : pathIdentity(root, true);
        if (rootIdentity && protectedIdentity.dev === rootIdentity.dev && protectedIdentity.ino === rootIdentity.ino) failure();
        if (overlaps(root, protectedRoot) || overlaps(protectedRoot, root)) failure();
      }
    }
    if (overlaps(roots[0]!, roots[1]!) || overlaps(roots[1]!, roots[0]!)) failure();
    if (input.invocationDeadline || proof) this.#validateTarget(input);
  }

  #validateTarget(input: V1ProjectionBaselineInput): void {
    const target = pathIdentity(this.#options.eventStorePath, false);
    for (const protectedRoot of [input.source.sourceRoot, input.sealedPackage.rootPath, this.#options.liveVaultRoot,
      dirname(this.#options.liveEventStorePath), this.#options.v1ProjectionDirectory, this.#options.v2ProjectionDirectory]) {
      if (overlaps(protectedRoot, this.#options.eventStorePath)) failure();
    }
    const sourceFile = pathIdentity(join(input.source.sourceRoot, input.source.manifest.database.relativePath), false);
    const live = pathIdentity(this.#options.liveEventStorePath, false);
    if ((target.dev === sourceFile.dev && target.ino === sourceFile.ino) || (target.dev === live.dev && target.ino === live.ino)) failure();
    const database = this.#options.connection.prepare("PRAGMA database_list").all().find(row => row.name === "main");
    if (typeof database?.file !== "string") failure();
    const connected = pathIdentity(database.file, false);
    if (target.dev !== connected.dev || target.ino !== connected.ino) failure();
  }

  #readRun(input: ShadowProjectionInput, baseline: string, operation: ProjectionOperation) {
    operation.check();
    const binding = input.source.projectionSnapshot.binding;
    const manifest = input.sealedPackage.manifest;
    // The callback makes authenticated observations only. Transaction locking is
    // housekeeping; none of the repository's mutation methods is used here.
    const phases = new SqliteV2ShadowMigrationRepository(this.#options.connection).transact(binding.projectId, input.sealedPackage.migrationIdentity, tx => {
      operation.check(); const run = tx.readRun(); operation.check();
      if (!run || run.rolloutRevisionId !== input.rolloutRevisionId || run.packageChecksum !== manifest.packageChecksum
        || run.sourceManifestChecksum !== manifest.sourceManifestChecksum || run.sourceTerminalHash !== manifest.terminalEventHash
        || run.sourceTerminalPosition !== BigInt(manifest.terminalEventPosition) || run.configurationChecksum !== manifest.configurationChecksum
        || run.buildIdentityHash !== manifest.buildIdentityHash || run.policyChecksum !== shadowMigrationPolicyChecksum(this.#options.policy)) failure();
      const revision = this.#options.connection.prepare("SELECT v1_baseline_checksum,build_identity_hash,migration_identity_hash,configuration_checksum FROM rollout_revisions WHERE project_id=$p AND revision_id=$r")
        .get({ $p: binding.projectId, $r: run.rolloutRevisionId });
      operation.check();
      if (revision?.v1_baseline_checksum !== baseline || revision.build_identity_hash !== manifest.buildIdentityHash
        || revision.migration_identity_hash !== input.sealedPackage.migrationIdentity || revision.configuration_checksum !== manifest.configurationChecksum) failure();
      const phases = tx.readTransitions(); operation.check();
      if (phases.length < 3 || phases[2]!.phase !== "import-committed") failure();
      const expected = shadowMigrationPhaseMetadata(input.sealedPackage.migrationIdentity, input.source.manifest.createdAt, 3);
      const phase = phases[3];
      if (phase && (phase.phase !== "projection-verified" || phase.ordinal !== 3 || phase.priorTransitionHash !== phases[2]!.transitionHash
        || phase.attemptId !== expected.attemptId || phase.recordedAt !== expected.recordedAt)) failure();
      operation.check(); return phases;
    });
    operation.check(); return phases;
  }

  async #openSnapshot(input: V1ProjectionBaselineInput, operation: ProjectionOperation): Promise<ProjectionEventSnapshot> {
    operation.check();
    const snapshot = await new V2ImportedProjectionEventReader({ driver: this.#options.driver, eventStorePath: this.#options.eventStorePath,
      busyTimeoutMs: Math.min(5000, operation.remaining()), sealedPackage: input.sealedPackage, sourceManifest: input.source.manifest })
      .openCommittedSnapshot(input.source.projectionSnapshot.binding);
    try { operation.check(); return guardedSnapshot(snapshot, operation); }
    catch (error) { try { snapshot.close(); } catch { /* preserve primary refusal */ } throw error; }
  }

  #verifyProof(input: V1ProjectionBaselineInput, operation: ProjectionOperation, verify: () => void): void {
    operation.check();
    try { verify(); }
    catch (error) {
      this.#unchanged(input, operation);
      if (operation.primaryFailure) throw operation.primaryFailure;
      // This existing API deliberately hides native read/cleanup causes. Only
      // this opaque verifier boundary is uncertain; explicit comparisons below
      // and typed source/target/ledger refusals retain their terminal meaning.
      if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") failure("MIGRATION_OUTCOME_UNKNOWN");
      throw error;
    }
    operation.check();
  }

  async #reconcile<I extends V1ProjectionBaselineInput, T>(input: I,
    action: (input: I, operation: ProjectionOperation) => Promise<ShadowMigrationReconciliation<T>>): Promise<ShadowMigrationReconciliation<T>> {
    try { return await this.#execute(input, action, true); }
    catch (error) {
      if (error instanceof ShadowMigrationError) {
        if (["MIGRATION_RETRY_EXHAUSTED", "MIGRATION_LIMIT_EXCEEDED", "MIGRATION_OUTCOME_UNKNOWN"].includes(error.code)) return unknownProof(error.code);
        throw safeFailure(error);
      }
      if ((error instanceof EventStoreError && error.code === "SQLITE_BUSY") || isPrimarySqliteBusy(error)) throw safeFailure(error);
      return unknownProof();
    }
  }

  async reconcileV1Baseline(input: V1ProjectionBaselineInput): Promise<ShadowMigrationReconciliation<PreparedV1ProjectionBaseline>> {
    return this.#reconcile(input, (captured, operation) => this.#readV1Baseline(captured, operation));
  }

  async #readV1Baseline(input: V1ProjectionBaselineInput, operation: ProjectionOperation): Promise<ShadowMigrationReconciliation<PreparedV1ProjectionBaseline>> {
    operation.check(); this.#validate(input, operation, true); operation.check();
    const directory = this.#options.v1ProjectionDirectory;
    const parent = captureProjectionDirectoryIdentity(dirname(directory));
    if (!existingIdentity(directory, true)) {
      this.#unchanged(input, operation);
      if (existingIdentity(directory, true) || !sameProjectionDirectoryIdentity(parent, captureProjectionDirectoryIdentity(dirname(directory)))) failure("MIGRATION_OUTCOME_UNKNOWN");
      operation.check(); return Object.freeze({ status: "absent" });
    }
    const lease = acquireProjectionManifestPublicationLease(directory);
    return owned(() => lease.release(), async () => {
      operation.check();
      const captured = filesystemStableProjectionDirectoryOperations.captureManifest(directory, lease.directoryIdentity);
      operation.check();
      const entries = () => readdirSync(directory).filter(name => name !== ".projection-manifest.publish.lock").sort();
      const before = entries(); operation.check();
      const confirm = () => {
        this.#unchanged(input, operation);
        if (!sameProjectionDirectoryIdentity(lease.directoryIdentity, captureProjectionDirectoryIdentity(directory))) failure();
        if (canonicalJson(captured) !== canonicalJson(filesystemStableProjectionDirectoryOperations.captureManifest(directory, lease.directoryIdentity))
          || canonicalJson(before) !== canonicalJson(entries())) failure("MIGRATION_OUTCOME_UNKNOWN");
        operation.check();
      };
      if (captured.state === "missing") {
        confirm(); return before.length === 0 ? Object.freeze({ status: "absent" }) : unknownProof();
      }
      let manifest: ProjectionManifestV1;
      try { manifest = parseProjectionManifest(JSON.parse(Buffer.from(captured.bytesBase64, "base64").toString("utf8")), input.source.projectionSnapshot.binding); }
      catch { failure(); }
      if (manifest.generation !== 1 || manifest.createdAt !== input.source.manifest.createdAt
        || manifest.terminalEventPosition !== input.source.manifest.terminalEventPosition || manifest.terminalEventHash !== input.source.manifest.terminalEventHash) failure();
      const databasePath = join(directory, manifest.databaseFile);
      if (!existingIdentity(databasePath, false)) { confirm(); return unknownProof(); }
      const image = observeV1Image(databasePath, lease.directoryIdentity, operation);
      operation.check(); if (image.sha256 !== manifest.databaseSha256) failure();
      const generation = Object.freeze({ manifest, projectionDirectory: directory, databasePath });
      this.#verifyProof(input, operation, () => this.#integrity(directory, operation).verifyV1Generation(guardedSnapshot(input.source.projectionSnapshot, operation), generation));
      confirm();
      const after = observeV1Image(databasePath, lease.directoryIdentity, operation);
      operation.check(); if (canonicalJson(after) !== canonicalJson(image)) failure();
      const result = Object.freeze({ generation, baselineChecksum: v1ProjectionBaselineChecksum(manifest), sourceManifestChecksum: input.source.manifest.manifestChecksum,
        terminalEventPosition: manifest.terminalEventPosition, terminalEventHash: manifest.terminalEventHash });
      return Object.freeze({ status: "committed", result });
    });
  }

  async reconcileV2(input: ShadowProjectionInput): Promise<ShadowMigrationReconciliation<ShadowProjectionResult>> {
    return this.#reconcile(input, async (input, operation) => {
      const baseline = await this.#readV1Baseline(input, operation); operation.check();
      if (baseline.status !== "committed") return unknownProof();
      const prepared = baseline.result;
      if (canonicalJson(prepared) !== canonicalJson(input.preparedV1)) failure();
      const phases = this.#readRun(input, prepared.baselineChecksum, operation);
      const snapshot = await this.#openSnapshot(input, operation);
      return owned(() => snapshot.close(), async () => {
        operation.check();
        const directory = this.#options.v2ProjectionDirectory;
        const parent = captureProjectionDirectoryIdentity(dirname(directory));
        if (!existingIdentity(directory, true)) {
          this.#unchanged(input, operation);
          if (canonicalJson(phases) !== canonicalJson(this.#readRun(input, prepared.baselineChecksum, operation))) return unknownProof();
          if (existingIdentity(directory, true) || !sameProjectionDirectoryIdentity(parent, captureProjectionDirectoryIdentity(dirname(directory)))) return unknownProof();
          operation.check(); return phases[3] ? unknownProof() : Object.freeze({ status: "absent" });
        }
        const lease = acquireProjectionManifestPublicationLease(directory);
        return owned(() => lease.release(), async () => {
          operation.check();
          const captured = filesystemStableProjectionDirectoryOperations.captureManifest(directory, lease.directoryIdentity);
          operation.check();
          const entries = () => readdirSync(directory).filter(name => name !== ".projection-manifest.publish.lock").sort();
          const before = entries(); operation.check();
          const confirm = async () => {
            const finalBaseline = await this.#readV1Baseline(input, operation); operation.check();
            if (finalBaseline.status !== "committed") failure("MIGRATION_OUTCOME_UNKNOWN");
            if (canonicalJson(finalBaseline.result) !== canonicalJson(prepared)) failure();
            this.#unchanged(input, operation);
            const finalPhases = this.#readRun(input, prepared.baselineChecksum, operation);
            if (canonicalJson(finalPhases) !== canonicalJson(phases)) failure("MIGRATION_OUTCOME_UNKNOWN");
            if (!sameProjectionDirectoryIdentity(lease.directoryIdentity, captureProjectionDirectoryIdentity(directory))) failure();
            if (canonicalJson(captured) !== canonicalJson(filesystemStableProjectionDirectoryOperations.captureManifest(directory, lease.directoryIdentity))
              || canonicalJson(before) !== canonicalJson(entries())) failure("MIGRATION_OUTCOME_UNKNOWN");
            operation.check();
          };
          if (captured.state === "missing") {
            await confirm(); return before.length === 0 && !phases[3] ? Object.freeze({ status: "absent" }) : unknownProof();
          }
          const binding = input.source.projectionSnapshot.binding;
          const manifest = (() => {
            try { return parseProjectionManifestV2(JSON.parse(Buffer.from(captured.bytesBase64, "base64").toString("utf8")), binding); }
            catch { return failure(); }
          })();
          if (manifest.createdAt !== input.source.manifest.createdAt || manifest.terminalEventPosition !== input.source.manifest.terminalEventPosition
            || manifest.terminalEventHash !== input.source.manifest.terminalEventHash) failure();
          // Known present phase evidence must not be hidden by an absent image.
          const v2ManifestChecksum = hash(canonicalJson(manifest));
          const evidenceDigest = hash(canonicalJson({ v1ManifestChecksum: hash(canonicalJson(prepared.generation.manifest)), v2ManifestChecksum, v1BaselineChecksum: prepared.baselineChecksum }));
          const phase = phases[3];
          if (phase && phase.evidenceDigest !== evidenceDigest) failure();
          const databasePath = join(directory, manifest.databaseFile);
          if (!existingIdentity(databasePath, false)) { await confirm(); return unknownProof(); }
          const image = filesystemStableProjectionDirectoryOperations.readGenerationImage(directory, lease.directoryIdentity, lease.lockToken, manifest.databaseFile);
          operation.check(); if (image.identity.sha256 !== manifest.databaseSha256) failure();
          this.#verifyProof(input, operation, () => this.#integrity(directory, operation).verifyCommittedSnapshot(binding, manifest, snapshot));
          await confirm();
          const after = filesystemStableProjectionDirectoryOperations.readGenerationImage(directory, lease.directoryIdentity, lease.lockToken, manifest.databaseFile);
          operation.check(); if (canonicalJson(image.identity) !== canonicalJson(after.identity)) failure();
          if (!phase) return unknownProof();
          const v2 = Object.freeze({ manifest, projectionDirectory: directory, databasePath, directoryIdentity: lease.directoryIdentity });
          return Object.freeze({ status: "committed", result: Object.freeze({ v1: prepared, v2, v1BaselineChecksum: prepared.baselineChecksum, v2ManifestChecksum }) });
        });
      });
    });
  }

  #integrity(directory: string, operation: ProjectionOperation): ProjectionIntegrityService {
    operation.check();
    return new ProjectionIntegrityService({ driver: this.#options.driver, eventStorePath: this.#options.eventStorePath,
      projectionDirectory: directory, busyTimeoutMs: Math.min(5000, operation.remaining()),
      maxReplayEvents: this.#options.policy.maxEvents, maxReplayBytes: this.#options.policy.maxAggregateBytes });
  }

  async prepareV1Baseline(input: V1ProjectionBaselineInput): Promise<PreparedV1ProjectionBaseline> {
    return this.#execute(input, (captured, operation) => this.#prepareV1Baseline(captured, operation));
  }

  async #prepareV1Baseline(input: V1ProjectionBaselineInput, operation: ProjectionOperation): Promise<PreparedV1ProjectionBaseline> {
      operation.check();
      this.#validate(input, operation);
      operation.check();
      const directory = this.#options.v1ProjectionDirectory;
      const lease = acquireProjectionManifestPublicationLease(directory);
      return owned(() => lease.release(), async () => {
        operation.check();
        const captured = filesystemStableProjectionDirectoryOperations.captureManifest(directory, lease.directoryIdentity);
        operation.check();
        const snapshot = guardedSnapshot(input.source.projectionSnapshot, operation);
        let generation: BuiltProjectionGeneration;
        if (captured.state === "present") {
          const manifest = parseProjectionManifest(JSON.parse(Buffer.from(captured.bytesBase64, "base64").toString("utf8")), input.source.projectionSnapshot.binding);
          generation = Object.freeze({ manifest, projectionDirectory: directory, databasePath: join(directory, manifest.databaseFile) });
        } else if (existsSync(join(directory, "projections-1-1.sqlite"))) {
          generation = this.#integrity(directory, operation).recoverV1Generation(snapshot, input.sealedPackage.manifest.createdAt);
        } else {
          operation.check();
          generation = await new ImmutableProjectionBuilder({ driver: this.#options.driver, projectionDirectory: directory,
            busyTimeoutMs: Math.min(5000, operation.remaining()),
            now: () => { operation.check(); operation.mayHavePublished = true; return input.sealedPackage.manifest.createdAt; } }).build(snapshot, 1);
        }
        operation.check();
        this.#integrity(directory, operation).verifyV1Generation(snapshot, generation);
        operation.check();
        if (generation.manifest.generation !== 1 || generation.manifest.createdAt !== input.sealedPackage.manifest.createdAt) failure();
        this.#unchanged(input, operation);
        if (!sameProjectionDirectoryIdentity(lease.directoryIdentity, captureProjectionDirectoryIdentity(directory))) failure();
        if (captured.state === "missing") {
          this.#options.faultInjector?.hit("before-v1-manifest", generation.databasePath);
          operation.check();
          this.#unchanged(input, operation);
          this.#integrity(directory, operation).verifyV1Generation(snapshot, generation);
          operation.check(); operation.mayHavePublished = true;
          publishProjectionManifest({ projectionDirectory: directory, manifest: generation.manifest,
            expectedBinding: input.source.projectionSnapshot.binding });
        }
        operation.check();
        return Object.freeze({ generation, baselineChecksum: v1ProjectionBaselineChecksum(generation.manifest),
          sourceManifestChecksum: input.source.manifest.manifestChecksum, terminalEventPosition: generation.manifest.terminalEventPosition,
          terminalEventHash: generation.manifest.terminalEventHash });
      });
  }

  async publishV2(input: ShadowProjectionInput): Promise<ShadowProjectionResult> {
    return this.#execute(input, async (input, operation) => {
      const now = this.#options.operationNow ?? (() => performance.now());
      this.#validate(input, operation);
      this.#validateTarget(input); operation.check();
      // Transaction authority comes only from the connection authenticated above.
      const repository = new SqliteV2ShadowMigrationRepository(this.#options.connection);
      const prepared = input.preparedV1;
      const binding = input.source.projectionSnapshot.binding;
      const manifest = input.sealedPackage.manifest;
      const baseline = v1ProjectionBaselineChecksum(prepared.generation.manifest);
      if (prepared.sourceManifestChecksum !== manifest.sourceManifestChecksum || prepared.terminalEventPosition !== manifest.terminalEventPosition
        || prepared.terminalEventHash !== manifest.terminalEventHash || baseline !== prepared.baselineChecksum) failure();
      operation.check();
      const adopted = await this.#prepareV1Baseline(input, operation);
      operation.check();
      if (canonicalJson(adopted) !== canonicalJson(prepared)) failure();
      const checkRun = () => this.#readRun(input, baseline, operation);
      checkRun();
      const reader = { openCommittedSnapshot: () => this.#openSnapshot(input, operation) };
      operation.check(); operation.mayHavePublished = true;
      const v2 = await new V2ProjectionBuildCoordinator({ eventReader: reader, projectionDirectory: this.#options.v2ProjectionDirectory,
        builder: new ImmutableProjectionBuilder({ driver: this.#options.driver, projectionDirectory: this.#options.v2ProjectionDirectory,
          busyTimeoutMs: Math.min(5000, operation.remaining()), now: () => { operation.check(); return manifest.createdAt; } }),
        now: () => { operation.check(); return now(); } }).ensurePublished(binding, BigInt(manifest.terminalEventPosition), operation.remaining());
      operation.check();
      if (v2.manifest.terminalEventPosition !== manifest.terminalEventPosition || v2.manifest.terminalEventHash !== manifest.terminalEventHash
        || BINDING_FIELDS.some(key => v2.manifest[key] !== binding[key]) || v2.manifest.createdAt !== manifest.createdAt) failure();
      this.#options.faultInjector?.hit("before-v2-integrity", v2.databasePath);
      operation.check();
      const snapshot = await reader.openCommittedSnapshot();
      await owned(() => snapshot.close(), async () => {
        operation.check(); this.#integrity(this.#options.v2ProjectionDirectory, operation).verifyCommittedSnapshot(binding, v2.manifest, snapshot);
        operation.check();
      });
      if (canonicalJson(await this.#prepareV1Baseline(input, operation)) !== canonicalJson(prepared)) failure();
      this.#unchanged(input, operation); checkRun();
      const v2ManifestChecksum = hash(canonicalJson(v2.manifest));
      const evidenceDigest = hash(canonicalJson({ v1ManifestChecksum: hash(canonicalJson(prepared.generation.manifest)), v2ManifestChecksum, v1BaselineChecksum: baseline }));
      operation.check();
      repository.transact(binding.projectId, input.sealedPackage.migrationIdentity, tx => {
        operation.check();
        const phases = tx.readTransitions();
        operation.check();
        const metadata = shadowMigrationPhaseMetadata(input.sealedPackage.migrationIdentity, input.source.manifest.createdAt, 3);
        if (phases[3]) {
          if (phases[3].phase !== "projection-verified" || phases[3].evidenceDigest !== evidenceDigest
            || phases[3].attemptId !== metadata.attemptId || phases[3].recordedAt !== metadata.recordedAt
            || phases[3].ordinal !== 3 || phases[3].priorTransitionHash !== phases[2]!.transitionHash) failure();
          operation.check(); return;
        }
        if (phases.length !== 3) failure();
        const body = { projectId: binding.projectId, migrationIdentity: input.sealedPackage.migrationIdentity, ordinal: 3,
          ...metadata, phase: "projection-verified" as const, priorTransitionHash: phases[2]!.transitionHash, evidenceDigest };
        operation.check(); operation.mayHavePublished = true;
        tx.appendTransition({ ...body, transitionHash: hash(`project-memory/v2-shadow-migration-transition/v1\n${canonicalJson(body)}`) });
        operation.check();
      });
      this.#unchanged(input, operation);
      return Object.freeze({ v1: prepared, v2, v1BaselineChecksum: baseline, v2ManifestChecksum });
    });
  }
}
