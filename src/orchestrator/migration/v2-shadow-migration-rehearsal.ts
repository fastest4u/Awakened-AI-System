import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, type BigIntStats } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { types } from "node:util";
import type { ProjectBinding } from "../projections/contracts.js";
import { isProjectionProjectStoreIdentity, isProjectionWorkspaceIdentity } from "../projections/contracts.js";
import { openImmutableProjectionImage } from "../projections/integrity.js";
import { parseSealedRetrievalEvaluationBundle, type RetrievalEvaluationBundleV2, type SealedRetrievalEvaluationCorpusV2 } from "../retrieval/evaluation.js";
import { authenticateSealedRetrievalSource } from "../parity/v2-snapshot-parity.js";
import { decodeExpectedDifferenceRuleV1, type ExpectedDifferenceRuleV1 } from "../parity/v2-expected-difference.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { SqliteDriver, SqliteConnection } from "../storage/sqlite-driver.js";
import type { ProjectContext } from "../identity/contracts.js";
import { NodeSqliteDriver } from "../storage/node-sqlite-driver.js";
import { MigrationRunner } from "../storage/migration-runner.js";
import { PROJECT_STORE_MIGRATIONS } from "../storage/migrations/registry.js";
import { v2ShadowMigration } from "../storage/migrations/0007-v2-shadow-migration.js";
import { SqliteQualifiedCheckpointMigrationPreflight } from "../storage/qualified-checkpoint-migration-preflight.js";
import { SqliteSessionEndEffectiveStateMigrationPreflight } from "../storage/session-end-effective-state-migration-preflight.js";
import { SqliteRolloutControlPlaneRepository } from "../storage/rollout-control-plane.repository.js";
import { SqliteV2ShadowMigrationRepository } from "../storage/v2-shadow-migration.repository.js";
import { RolloutControlPlane } from "../rollout/rollout-control-plane.js";
import { decodeRolloutRevision, type RolloutRevision } from "../rollout/rollout-cohort.js";
import { MAX_CANONICAL_COMMAND_BYTES, MAX_EVENTS_PER_COMMAND } from "../storage/event-store.js";
import { sealV2MigrationPackage } from "./v2-migration-package.js";
import { V2ShadowProjectionPublisher } from "./v2-shadow-projection.js";
import { V2ShadowMigrationRunner, type V2ShadowMigrationRunInput, type V2ShadowMigrationRunResult } from "./v2-shadow-migration-runner.js";
import { readV2ShadowImportBatchObservation } from "./v2-shadow-importer.js";
import { buildV2ShadowMigrationEvidence, reserveV2ShadowMigrationEvidence, writeV2ShadowMigrationEvidence,
  type DeterministicRunEvidenceV1, type V2ShadowMigrationEvidenceV1, type V2ShadowMigrationEvidenceReservation } from "./v2-shadow-migration-evidence.js";
import { verifyV1SourceCopy, type VerifiedV1SourceCopy } from "./v1-source-copy.js";
import { decodeShadowMigrationConfigurationV1, decodeShadowMigrationPolicyV1, shadowMigrationPolicyChecksum, shadowMigrationConfigurationChecksum,
  ShadowMigrationError, type ShadowMigrationConfigurationV1, type ShadowMigrationPolicyV1 } from "./v2-shadow-migration.contracts.js";
import { createShadowMigrationInvocationDeadline, type ShadowMigrationInvocationDeadline } from "./v2-shadow-migration-runtime.js";

/** Private read-only preparation only; no build/source approval or rollout authority. */
export interface V2ShadowMigrationRehearsalPreflightInput {
  readonly sourceRoot: string; readonly sourceManifestPath: string;
  readonly liveEventStorePath: string; readonly liveLegacyArtifactRoot: string;
  readonly expectedBinding: ProjectBinding; readonly configuration: ShadowMigrationConfigurationV1;
  readonly policy: ShadowMigrationPolicyV1; readonly expectedDifferenceRules: readonly ExpectedDifferenceRuleV1[];
  readonly sealedRetrieval: Readonly<{ bundleRoot: string; expectedBundle: RetrievalEvaluationBundleV2 }>;
}
export interface V2ShadowMigrationRehearsalPreflight {
  readonly input: V2ShadowMigrationRehearsalPreflightInput;
  readonly corpus: SealedRetrievalEvaluationCorpusV2; readonly source: VerifiedV1SourceCopy;
  readonly identity: Readonly<{ sourceChecksum: string; corpusChecksum: string }>;
  assertUnchanged(): void;
  close(): void;
}
const INPUT_KEYS = ["sourceRoot", "sourceManifestPath", "liveEventStorePath", "liveLegacyArtifactRoot", "expectedBinding",
  "configuration", "policy", "expectedDifferenceRules", "sealedRetrieval"] as const;
const ARTIFACTS = ["manifest.json", "source-events.json", "judgments.json", "v1-shadow-baseline.json"] as const;
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function invalid(): never { throw new ShadowMigrationError("MIGRATION_SOURCE_INVALID"); }
function limit(): never { throw new ShadowMigrationError("MIGRATION_LIMIT_EXCEEDED"); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) invalid();
}
// Capture own data before filesystem access; caller accessors/proxies never execute.
function capture(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }, seen = new Set<object>()): any {
  if (depth > 32 || ++budget.nodes > 65536) limit();
  if (typeof value === "string") { budget.bytes += Buffer.byteLength(value); if (budget.bytes > 1048576) limit(); return value; }
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value !== "object" || types.isProxy(value) || seen.has(value)) invalid();
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) invalid();
  const output: Record<string, unknown> | unknown[] = array ? [] : {};
  seen.add(value);
  let count = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || !descriptor.enumerable || !("value" in descriptor)
      || (array && key !== String(count++))) invalid();
    budget.bytes += Buffer.byteLength(key); if (budget.bytes > 1048576) limit();
    Object.defineProperty(output, key, { value: capture(descriptor.value, depth + 1, budget, seen), enumerable: true });
  }
  if (array && count !== (value as unknown[]).length) invalid();
  seen.delete(value); return Object.freeze(output);
}
export function decodeV2ShadowMigrationRehearsalPreflightInput(input: unknown): V2ShadowMigrationRehearsalPreflightInput {
  const value = capture(input); exact(value, INPUT_KEYS);
  const policy = decodeShadowMigrationPolicyV1(value.policy), configuration = decodeShadowMigrationConfigurationV1(value.configuration);
  if (configuration.policyChecksum !== shadowMigrationPolicyChecksum(policy)
    || configuration.expectedDifferencePolicyVersion !== policy.expectedDifferencePolicyVersion) invalid();
  const binding = value.expectedBinding; exact(binding, ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId"]);
  if (![binding.projectId, binding.vaultId, binding.storeId].every(isProjectionProjectStoreIdentity)
    || !isProjectionWorkspaceIdentity(binding.workspaceId) || binding.sessionId !== null
    || !(binding.branchScopeId === null || (typeof binding.branchScopeId === "string" && UUID.test(binding.branchScopeId)))
    || !(binding.branchRef === null || (typeof binding.branchRef === "string" && binding.branchRef.length > 0 && !binding.branchRef.includes("\0")))) invalid();
  exact(value.sealedRetrieval, ["bundleRoot", "expectedBundle"]);
  for (const path of [value.sourceRoot, value.sourceManifestPath, value.liveEventStorePath, value.liveLegacyArtifactRoot, value.sealedRetrieval.bundleRoot])
    if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || path.includes("\0")) invalid();
  const bundle = value.sealedRetrieval.expectedBundle;
  exact(bundle, ["schemaVersion", "corpusVersion", "files"]); exact(bundle.files, ARTIFACTS.slice(1));
  if (bundle.schemaVersion !== 2 || bundle.corpusVersion !== "retrieval-evaluation-v2"
    || Object.values(bundle.files).some(hash => typeof hash !== "string" || !HASH.test(hash))) invalid();
  if (!Array.isArray(value.expectedDifferenceRules) || value.expectedDifferenceRules.length > 4096) invalid();
  const ids = new Set<string>();
  const rules = value.expectedDifferenceRules.map((rule: unknown) => {
    const decoded = decodeExpectedDifferenceRuleV1(rule);
    if (ids.has(decoded.ruleId) || decoded.policyVersion !== policy.expectedDifferencePolicyVersion) invalid();
    ids.add(decoded.ruleId); return decoded;
  });
  return Object.freeze({ ...value, policy, configuration, expectedDifferenceRules: Object.freeze(rules) }) as V2ShadowMigrationRehearsalPreflightInput;
}
interface PathPin { readonly path: string; readonly stat: BigIntStats; }
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && b.isFile() && b.nlink === 1n && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function pathPin(value: unknown, directory: boolean): PathPin {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value.includes("\0") || realpathSync.native(value) !== value) invalid();
  let cursor = value;
  while (true) {
    const stat = lstatSync(cursor, { bigint: true });
    if (stat.isSymbolicLink() || (cursor !== value && !stat.isDirectory())) invalid();
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  const stat = lstatSync(value, { bigint: true });
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) invalid();
  return { path: value, stat };
}
function overlaps(a: string, b: string): boolean {
  const child = relative(a, b); return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}
interface ArtifactPin extends PathPin { readonly sha256: string; }
function readArtifact(pin: PathPin, maxBytes: number, deadline: ShadowMigrationInvocationDeadline): { bytes: Buffer; pin: ArtifactPin } {
  deadline.remainingMs();
  if (pin.stat.size > BigInt(maxBytes) || pin.stat.size > BigInt(Number.MAX_SAFE_INTEGER)) limit();
  let fd: number | undefined, failed = false;
  try {
    fd = openSync(pin.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!sameFile(pin.stat, fstatSync(fd, { bigint: true }))) invalid();
    const bytes = Buffer.alloc(Number(pin.stat.size)); let offset = 0;
    while (offset < bytes.length) {
      deadline.remainingMs();
      const count = readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (count === 0) invalid(); offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 || !sameFile(pin.stat, fstatSync(fd, { bigint: true }))
      || !sameFile(pin.stat, pathPin(pin.path, false).stat)) invalid();
    deadline.remainingMs(); return { bytes, pin: { ...pin, sha256: createHash("sha256").update(bytes).digest("hex") } };
  } catch (error) { failed = true; throw error; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch (error) { if (!failed) throw error; } } }
}
function hashArtifact(pin: PathPin, maxBytes: number, deadline: ShadowMigrationInvocationDeadline): ArtifactPin {
  deadline.remainingMs(); if (pin.stat.size > BigInt(maxBytes)) limit();
  let fd: number | undefined, failed = false;
  try {
    fd = openSync(pin.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!sameFile(pin.stat, fstatSync(fd, { bigint: true }))) invalid();
    const buffer = Buffer.alloc(65536), hash = createHash("sha256"); let offset = 0;
    while (offset < Number(pin.stat.size)) {
      deadline.remainingMs(); const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(pin.stat.size) - offset), offset);
      if (count < 1) invalid(); hash.update(buffer.subarray(0, count)); offset += count;
    }
    if (readSync(fd, buffer, 0, 1, offset) !== 0 || !sameFile(pin.stat, fstatSync(fd, { bigint: true }))
      || !sameFile(pin.stat, pathPin(pin.path, false).stat)) invalid();
    deadline.remainingMs(); return { ...pin, sha256: hash.digest("hex") };
  } catch (error) { failed = true; throw error; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch (error) { if (!failed) throw error; } }
}

/** No target, package, revision, reservation or evidence writes. The accepted source
 * verifier owns its existing temporary working image. Call close on every handoff exit.
 * Persistent identity/byte changes are detected; this is not hostile pathname atomicity.
 */
export async function preflightV2ShadowMigrationRehearsal(supplied: unknown, options: Readonly<{ driver: SqliteDriver }>): Promise<V2ShadowMigrationRehearsalPreflight> {
  let source: VerifiedV1SourceCopy | undefined;
  let deadline: ReturnType<typeof createShadowMigrationInvocationDeadline> | undefined;
  try {
    const input = decodeV2ShadowMigrationRehearsalPreflightInput(supplied);
    deadline = createShadowMigrationInvocationDeadline(input.policy.deadlineMs);
    const roots = [pathPin(input.sourceRoot, true), pathPin(input.liveLegacyArtifactRoot, true), pathPin(input.sealedRetrieval.bundleRoot, true)];
    const manifest = pathPin(input.sourceManifestPath, false), live = pathPin(input.liveEventStorePath, false);
    if (!overlaps(input.sourceRoot, manifest.path) || overlaps(input.sourceRoot, live.path)
      || overlaps(input.sealedRetrieval.bundleRoot, live.path)) invalid();
    for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
      if (sameIdentity(roots[i]!.stat, roots[j]!.stat) || overlaps(roots[i]!.path, roots[j]!.path) || overlaps(roots[j]!.path, roots[i]!.path)) invalid();
    }
    const files = ARTIFACTS.map(name => pathPin(join(input.sealedRetrieval.bundleRoot, name), false));
    let total = 0n;
    for (const file of files) { total += file.stat.size; if (total > BigInt(input.policy.maxAggregateBytes)) limit(); }
    // Do not retain the raw file buffers in the returned handoff closures.
    const { corpus, pins } = (() => {
      const reads = files.map(file => readArtifact(file, input.policy.maxAggregateBytes, deadline!));
      const json = reads.map(read => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)) as unknown);
      return { corpus: parseSealedRetrievalEvaluationBundle(json[0], json[1], json[2], json[3]), pins: reads.map(read => read.pin) };
    })();
    if (canonicalJson(corpus.bundle) !== canonicalJson(input.sealedRetrieval.expectedBundle)) invalid();
    source = await verifyV1SourceCopy({ driver: options.driver, sourceRoot: input.sourceRoot, manifestPath: input.sourceManifestPath,
      liveEventStorePath: input.liveEventStorePath, liveLegacyArtifactRoot: input.liveLegacyArtifactRoot,
      expectedBinding: input.expectedBinding, policy: input.policy, invocationDeadline: deadline });
    const authenticated = authenticateSealedRetrievalSource(corpus, source, deadline);
    const fileIdentity = (pin: ArtifactPin) => ({ device: String(pin.stat.dev), inode: String(pin.stat.ino),
      size: String(pin.stat.size), mtimeNs: String(pin.stat.mtimeNs), ctimeNs: String(pin.stat.ctimeNs), sha256: pin.sha256 });
    const rootIdentity = (pin: PathPin) => ({ device: String(pin.stat.dev), inode: String(pin.stat.ino) });
    const manifestPin = hashArtifact(manifest, 64 * 1024 * 1024, deadline);
    const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
    // The verifier authenticates every source descriptor against current identities and bytes.
    // Include the actual manifest bytes and root identities, which its logical checksum omits.
    const identity = Object.freeze({
      sourceChecksum: digest({ root: rootIdentity(roots[0]!), manifest: fileIdentity(manifestPin),
        database: source.manifest.database, sidecars: source.manifest.sqliteSidecars, artifacts: source.manifest.legacyArtifacts }),
      corpusChecksum: digest({ root: rootIdentity(roots[2]!), files: pins.map(fileIdentity) }),
    });
    const ownedSource = source, ownedDeadline = deadline; let closed = false;
    const assertUnchanged = (): void => {
      try {
        if (closed) invalid(); ownedDeadline.remainingMs();
        for (const root of roots) if (!sameIdentity(root.stat, pathPin(root.path, true).stat)) invalid();
        if (!sameIdentity(live.stat, pathPin(live.path, false).stat)) invalid();
        for (const pin of pins) {
          const current = pathPin(pin.path, false);
          if (!sameFile(pin.stat, current.stat) || readArtifact(current, input.policy.maxAggregateBytes, ownedDeadline).pin.sha256 !== pin.sha256) invalid();
        }
        ownedSource.assertUnchanged(); ownedDeadline.remainingMs();
      } catch (error) {
        if (error instanceof ShadowMigrationError) throw error;
        invalid();
      }
    };
    const close = (): void => { if (closed) return; closed = true; try { ownedSource.close(); } finally { ownedDeadline.dispose(); } };
    assertUnchanged();
    return Object.freeze({ input, corpus: authenticated, source: ownedSource, identity, assertUnchanged, close });
  } catch (error) {
    try { source?.close(); } catch { /* Preserve the primary failure. */ }
    deadline?.dispose();
    if (error instanceof ShadowMigrationError) throw error;
    invalid();
  }
}

interface RehearsalBuildHandoff {
  readonly commit: string; readonly buildIdentityHash: string; readonly protectedRoots: readonly string[];
  assertUnchanged(): void;
}
interface RehearsalCommandInput {
  readonly sourceRoot: string; readonly packageRoot: string; readonly workRoot: string; readonly evidenceOutput: string;
  readonly config: unknown;
}
type RevisionTemplate = Omit<RolloutRevision, "migrationIdentityHash" | "v1BaselineChecksum">;
const revisionKeys = ["projectId", "revisionId", "parentRevisionId", "buildIdentityHash", "configurationChecksum",
  "cohortAlgorithmVersion", "cohortSalt", "cohortBasisPoints", "createdAt"];
const checksum = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(); return value;
}
function metadata(config: Record<string, any>): void {
  const label = (value: unknown) => {
    if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9_. -]{0,127}$/.test(value)
      || /(?:sk-|ghp_|AKIA)/i.test(value)) invalid();
  };
  if (!Array.isArray(config.tests) || config.tests.length > 4096 || !Array.isArray(config.reviews) || config.reviews.length > 3) invalid();
  const names = new Set(), kinds = new Set();
  for (const test of config.tests) {
    exact(test, ["name", "passed", "failed", "skipped"]); label(test.name);
    if (names.has(test.name)) invalid(); names.add(test.name);
    integer(test.passed); integer(test.failed); integer(test.skipped);
  }
  for (const review of config.reviews) {
    exact(review, ["kind", "disposition", "evidenceDigest"]);
    if (!["specification", "implementation-quality", "security"].includes(review.kind)
      || !["approved", "changes-required"].includes(review.disposition) || kinds.has(review.kind)
      || typeof review.evidenceDigest !== "string" || !HASH.test(review.evidenceDigest)) invalid();
    kinds.add(review.kind);
  }
}
function assertPins(pins: readonly PathPin[]): void {
  for (const pin of pins) if (!sameIdentity(pin.stat, pathPin(pin.path, pin.stat.isDirectory()).stat)) invalid();
}
function emptyRoot(value: unknown): PathPin {
  const pin = pathPin(value, true); if (readdirSync(pin.path).length !== 0) invalid(); return pin;
}
function initializeTarget(driver: SqliteDriver, path: string, binding: ProjectBinding, createdAt: string): void {
  const connection = driver.open(path, { mode: "create", busyTimeoutMs: 5000 });
  try {
    const checkpoint = new SqliteQualifiedCheckpointMigrationPreflight(), sessionEnd = new SqliteSessionEndEffectiveStateMigrationPreflight();
    new MigrationRunner().apply(connection, PROJECT_STORE_MIGRATIONS, createdAt, { kind: "bootstrap-empty", beforeMigration(db, migration) {
      const context = { binding } as unknown as ProjectContext;
      if (migration.version === 3) {
        db.prepare("INSERT INTO project_meta(singleton,project_id,vault_id,store_id,schema_version,created_at) VALUES(1,$p,$v,$s,2,$t)")
          .run({ $p: binding.projectId, $v: binding.vaultId, $s: binding.storeId, $t: createdAt });
        db.exec("INSERT INTO maintenance_state(singleton,epoch,mode,owner_id,fencing_token,lease_expires_at,requested_at) VALUES(1,0,'idle',NULL,0,NULL,NULL)");
        checkpoint.assertEligibleAndStage(db, context);
      }
      if (migration.version === 4) sessionEnd.assertEligible(db, context);
    } });
    // Schema7 registration is Task13. Match the accepted isolated Task11 setup only.
    if (!PROJECT_STORE_MIGRATIONS.some(migration => migration.version === v2ShadowMigration.version)) connection.exec(v2ShadowMigration.sql);
  } finally { connection.close(); }
}
function targetContext(binding: ProjectBinding, root: string, eventStorePath: string, revision: RevisionTemplate): ProjectContext {
  const workspace = { kind: "non-git" as const, workspaceRoot: root, workspaceId: binding.workspaceId };
  return { workspace, checkedAt: revision.createdAt, ...(binding.branchScopeId ? { branchScopeId: binding.branchScopeId } : {}), binding: {
    ...binding, projectBindingId: revision.revisionId, generation: 1, contextFingerprint: revision.buildIdentityHash,
    source: "explicit-cli", clientNamespace: "v2-shadow-rehearsal", clientInstanceId: revision.revisionId, actorRole: "primary",
    projectRoot: root, vaultRoot: root, descriptorPath: join(root, ".project-memory.json"), workspace, establishedAt: revision.createdAt,
    storeRoute: { kind: "vault-local", storeRoot: root, eventsPath: eventStorePath,
      storeManifestPath: join(root, "store.json"), projectionManifestPath: join(root, "projection.json") },
  } };
}
function decimal(value: unknown): any {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(decimal);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, decimal(v)]));
  return value;
}
function readRunEvidence(driver: SqliteDriver, input: V2ShadowMigrationRunInput, result: V2ShadowMigrationRunResult,
  runOrdinal: 1 | 2 | 3 | 4): { run: DeterministicRunEvidenceV1; retries: number; schemaVersion: number; sqliteVersion: string } {
  const connection = driver.open(input.targetContext.binding.storeRoute.eventsPath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
  try {
    const ledger = new SqliteV2ShadowMigrationRepository(connection).transact(input.projectId, result.migrationIdentity, tx => ({
      transitions: tx.readTransitions(), attempts: tx.readAttemptEvidence(), pending: tx.readPendingCompatibility(), acknowledgements: tx.readCompatibilityAcknowledgements(),
    }));
    if (ledger.transitions.length !== 6 || ledger.pending.length !== 0 || ledger.acknowledgements.length !== result.compatibility.acknowledgedCount
      || result.parity.blockingDivergenceCount !== 0 || result.parity.sealedRetrieval.queryCount !== input.sealedRetrieval.corpus.queries.length) invalid();
    const schemaVersion = integer(Number(connection.prepare("SELECT schema_version AS version FROM project_meta WHERE singleton=1").get()!.version));
    const sqliteVersion = String(connection.prepare("SELECT sqlite_version() AS version").get()!.version);
    const run = Object.freeze({ runOrdinal, deduplicated: result.deduplicated, determinismVector: Object.freeze({
      migrationIdentity: result.migrationIdentity, packageChecksum: result.packageChecksum, importedEventsChecksum: result.import.importedEventsChecksum,
      transitionChainChecksum: checksum(ledger.transitions), v2ProjectionManifestChecksum: result.projection.v2ManifestChecksum,
      parityReportChecksum: result.parity.reportChecksum, compatibilityArtifactSetChecksum: result.compatibility.artifactSetChecksum,
      sourceRecordCount: result.import.recordCount, importedEventCount: result.import.eventIds.length,
      compatibilityAcknowledgementCount: result.compatibility.acknowledgedCount,
    }) });
    return { run, retries: ledger.attempts.filter(a => a.outcomeCategory === "retryable-failure").length, schemaVersion, sqliteVersion };
  } finally { connection.close(); }
}
/** Bounded streaming digest of semantic tables; no physical SQLite/WAL bytes enter evidence. */
function semanticDigest(driver: SqliteDriver, path: string, policy: ShadowMigrationPolicyV1): string {
  const deadline = createShadowMigrationInvocationDeadline(policy.deadlineMs); let connection: SqliteConnection | undefined;
  try {
    connection = driver.open(path, { mode: "read-only-existing", busyTimeoutMs: Math.min(5000, deadline.remainingMs()) });
    const hash = createHash("sha256"), quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const tables = connection.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all();
    if (tables.length > 256) invalid();
    for (const row of tables) {
      deadline.remainingMs(); const name = String(row.name); if (name === "v2_shadow_migration_attempts") continue;
      const columns = connection.prepare(`PRAGMA table_info(${quote(name)})`).all().map(c => quote(String(c.name)));
      hash.update(name + "\n");
      for (const record of connection.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${columns.join(",")}`).iterate()) {
        deadline.remainingMs(); hash.update(canonicalJson(decimal(record)) + "\n");
      }
    }
    deadline.remainingMs(); return hash.digest("hex");
  } finally { try { connection?.close(); } finally { deadline.dispose(); } }
}
function artifactDigest(roots: readonly string[], policy: ShadowMigrationPolicyV1): string {
  const deadline = createShadowMigrationInvocationDeadline(policy.deadlineMs), hash = createHash("sha256"); let entries = 0;
  const visit = (root: string, relativePath: string): void => {
    deadline.remainingMs(); if (++entries > policy.maxEvents + 1024) limit();
    const path = join(root, relativePath), stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) invalid();
    if (stat.isDirectory()) { pathPin(path, true); for (const leaf of readdirSync(path).sort()) visit(root, join(relativePath, leaf)); }
    else {
      const pin = hashArtifact(pathPin(path, false), 128 * 1024 * 1024, deadline);
      hash.update(canonicalJson([relativePath, String(stat.dev), String(stat.ino), pin.sha256]) + "\n");
    }
  };
  try { for (const [index, root] of roots.entries()) { hash.update(String(index)); visit(root, ""); } return hash.digest("hex"); }
  finally { deadline.dispose(); }
}
function projectionCounts(result: V2ShadowMigrationRunResult, policy: ShadowMigrationPolicyV1): Readonly<Record<string, number>> {
  const deadline = createShadowMigrationInvocationDeadline(policy.deadlineMs); let database: DatabaseSync | undefined;
  try {
    const path = result.projection.v2.databasePath, pin = pathPin(path, false);
    const image = readArtifact(pin, 128 * 1024 * 1024, deadline);
    if (image.pin.sha256 !== result.projection.v2.manifest.databaseSha256) invalid();
    database = openImmutableProjectionImage(image.bytes, Math.min(5000, deadline.remainingMs()));
    const counts: Record<string, number> = {};
    for (const [name, table] of [["projectedLifecycleSessions", "session_tree"], ["projectedCheckpoints", "session_checkpoints"],
      ["projectedFollowUps", "tasks_followups"]] as const) {
      deadline.remainingMs(); counts[name] = integer(Number(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count));
    }
    if (!sameFile(pin.stat, pathPin(path, false).stat)
      || hashArtifact(pin, 128 * 1024 * 1024, deadline).sha256 !== result.projection.v2.manifest.databaseSha256) invalid();
    return Object.freeze(counts);
  } finally { try { database?.close(); } finally { deadline.dispose(); } }
}
export function readV2ShadowRehearsalResources(results: readonly V2ShadowMigrationRunResult[], policy: ShadowMigrationPolicyV1): Readonly<{ maxBatchEvents: number; maxBatchBytes: number; peakRssBytes: number }> {
  if (results.length !== 4) invalid(); let maxBatchEvents = 0, maxBatchBytes = 0;
  for (const result of results) {
    const observation = readV2ShadowImportBatchObservation(result.import); if (!observation) invalid();
    maxBatchEvents = Math.max(maxBatchEvents, observation.maxBatchEvents); maxBatchBytes = Math.max(maxBatchBytes, observation.maxBatchBytes);
  }
  if (maxBatchEvents > Math.min(policy.maxBatchEvents, MAX_EVENTS_PER_COMMAND)
    || maxBatchBytes > Math.min(policy.maxBatchBytes, MAX_CANONICAL_COMMAND_BYTES)) limit();
  const raw = integer(process.resourceUsage().maxRSS), peakRssBytes = integer(raw * 1024);
  return Object.freeze({ maxBatchEvents, maxBatchBytes, peakRssBytes });
}

/** Explicit private command only. Importing this module never initializes a store. */
export async function runV2ShadowMigrationRehearsal(supplied: unknown, build: RehearsalBuildHandoff): Promise<Readonly<{
  evidenceChecksum: string; migrationIdentity: string; gates: readonly { name: string; status: "passed" | "failed" }[]; outputPathHash: string;
}>> {
  const value = capture(supplied); exact(value, ["sourceRoot", "packageRoot", "workRoot", "evidenceOutput", "config"]);
  const command = value as RehearsalCommandInput, config = value.config;
  exact(config, [...INPUT_KEYS.filter(key => key !== "sourceRoot"), "buildIdentityHash", "rolloutRevisionTemplate", "tests", "reviews"]);
  const preflightInput = decodeV2ShadowMigrationRehearsalPreflightInput(Object.fromEntries(INPUT_KEYS.map(key => [key, key === "sourceRoot" ? command.sourceRoot : config[key]])));
  metadata(config); exact(config.rolloutRevisionTemplate, revisionKeys);
  const template = config.rolloutRevisionTemplate as unknown as RevisionTemplate;
  decodeRolloutRevision({ ...template, migrationIdentityHash: "0".repeat(64), v1BaselineChecksum: "0".repeat(64) });
  const configurationChecksum = shadowMigrationConfigurationChecksum(preflightInput.configuration);
  if (!/^[0-9a-f]{40}$/.test(build.commit) || config.buildIdentityHash !== build.buildIdentityHash
    || template.buildIdentityHash !== build.buildIdentityHash || template.configurationChecksum !== configurationChecksum
    || template.projectId !== preflightInput.expectedBinding.projectId || template.parentRevisionId !== null || template.cohortBasisPoints !== 0) invalid();
  build.assertUnchanged();
  const roots = [emptyRoot(command.workRoot), emptyRoot(command.packageRoot)];
  const protectedRoots = [preflightInput.sourceRoot, preflightInput.sourceManifestPath, preflightInput.sealedRetrieval.bundleRoot,
    preflightInput.liveEventStorePath, preflightInput.liveLegacyArtifactRoot, ...build.protectedRoots];
  for (const root of roots) for (const protectedRoot of [...protectedRoots, ...roots.filter(other => other !== root).map(other => other.path)]) {
    if (overlaps(root.path, protectedRoot) || overlaps(protectedRoot, root.path)) invalid();
  }
  const driver = new NodeSqliteDriver({ DatabaseSync }), started = performance.now();
  let initial: V2ShadowMigrationRehearsalPreflight | undefined, reservation: V2ShadowMigrationEvidenceReservation | undefined;
  let publishing = false, failed = false;
  try {
    initial = await preflightV2ShadowMigrationRehearsal(preflightInput, { driver });
    const identity = initial.identity, manifest = initial.source.manifest, corpus = initial.corpus;
    assertPins(roots); build.assertUnchanged(); initial.assertUnchanged();
    reservation = await reserveV2ShadowMigrationEvidence({ outputPath: command.evidenceOutput,
      protectedRoots: [...protectedRoots, ...roots.map(root => root.path)], timeoutMs: 3600000 });
    assertPins(roots); initial.assertUnchanged();
    const makeTarget = (name: string) => {
      assertPins(roots); const root = join(command.workRoot, name), packageRoot = join(command.packageRoot, name);
      mkdirSync(root, { mode: 0o700 }); mkdirSync(packageRoot, { mode: 0o700 });
      const v1ProjectionRoot = join(root, "v1"), v2ProjectionRoot = join(root, "v2"), compatibilityRoot = join(root, "compatibility");
      for (const path of [v1ProjectionRoot, v2ProjectionRoot, compatibilityRoot]) mkdirSync(path, { mode: 0o700 });
      const eventStorePath = join(root, "events.sqlite"); initializeTarget(driver, eventStorePath, preflightInput.expectedBinding, manifest.createdAt);
      return { root, packageRoot, v1ProjectionRoot, v2ProjectionRoot, compatibilityRoot, eventStorePath };
    };
    const prepared = makeTarget("preparation"), preparationDeadline = createShadowMigrationInvocationDeadline(preflightInput.policy.deadlineMs);
    let package_: Awaited<ReturnType<typeof sealV2MigrationPackage>> | undefined, baselineChecksum: string;
    try {
      package_ = await sealV2MigrationPackage({ source: initial.source, packageRoot: prepared.packageRoot, policy: preflightInput.policy,
        buildIdentityHash: build.buildIdentityHash, configurationChecksum, invocationDeadline: preparationDeadline });
      const connection = driver.open(prepared.eventStorePath, { mode: "existing", busyTimeoutMs: 5000, bindFileIdentity: true });
      try {
        baselineChecksum = (await new V2ShadowProjectionPublisher({ driver, connection, eventStorePath: prepared.eventStorePath,
          liveEventStorePath: preflightInput.liveEventStorePath, liveVaultRoot: preflightInput.liveLegacyArtifactRoot,
          v1ProjectionDirectory: prepared.v1ProjectionRoot, v2ProjectionDirectory: prepared.v2ProjectionRoot, policy: preflightInput.policy })
          .prepareV1Baseline({ source: initial.source, sealedPackage: package_, invocationDeadline: preparationDeadline })).baselineChecksum;
      } finally { connection.close(); }
      initial.assertUnchanged(); preparationDeadline.remainingMs();
    } finally { try { package_?.close(); } finally { preparationDeadline.dispose(); } }
    const revision = decodeRolloutRevision({ ...template, migrationIdentityHash: package_.migrationIdentity, v1BaselineChecksum: baselineChecksum });
    initial.close(); initial = undefined;
    const results: V2ShadowMigrationRunResult[] = [], runs: DeterministicRunEvidenceV1[] = [];
    let lastInput!: V2ShadowMigrationRunInput, lastPaths!: ReturnType<typeof makeTarget>, semanticBefore = "", artifactsBefore = "";
    let retries = 0, passThreeRetries = 0, schemaVersion = 0, sqliteVersion = "";
    for (const ordinal of [1, 2, 3, 4] as const) {
      assertPins(roots); build.assertUnchanged();
      if (ordinal < 4) {
        lastPaths = makeTarget(`run-${ordinal}`);
        const connection = driver.open(lastPaths.eventStorePath, { mode: "existing", busyTimeoutMs: 5000 });
        try {
          const control = new RolloutControlPlane(new SqliteRolloutControlPlaneRepository(connection));
          control.createRevision(revision); if (control.state(template.projectId).mode !== "off") invalid();
        } finally { connection.close(); }
        lastInput = { projectId: template.projectId, rolloutRevisionId: template.revisionId,
          targetContext: targetContext(preflightInput.expectedBinding, lastPaths.root, lastPaths.eventStorePath, template),
          expectedSourceBinding: preflightInput.expectedBinding,
          sourceRoot: preflightInput.sourceRoot, sourceManifestPath: preflightInput.sourceManifestPath,
          liveEventStorePath: preflightInput.liveEventStorePath, liveLegacyArtifactRoot: preflightInput.liveLegacyArtifactRoot,
          packageRoot: lastPaths.packageRoot, v1ProjectionRoot: lastPaths.v1ProjectionRoot, v2ProjectionRoot: lastPaths.v2ProjectionRoot,
          compatibilityRoot: lastPaths.compatibilityRoot, buildIdentityHash: build.buildIdentityHash,
          configuration: preflightInput.configuration, policy: preflightInput.policy, expectedDifferenceRules: preflightInput.expectedDifferenceRules,
          sealedRetrieval: { corpus, expectedBundle: preflightInput.sealedRetrieval.expectedBundle }, creationReasonCode: "production-shaped-rehearsal" };
      }
      // No clock override: every invocation obtains actual fresh UTC/monotonic clocks.
      const result = await new V2ShadowMigrationRunner({ driver }).run(lastInput);
      const observed = readRunEvidence(driver, lastInput, result, ordinal);
      if (result.deduplicated !== (ordinal === 4) || result.migrationIdentity !== revision.migrationIdentityHash
        || (runs.length && canonicalJson(observed.run.determinismVector) !== canonicalJson(runs[0]!.determinismVector))) invalid();
      const newRetries = ordinal === 4 ? observed.retries - passThreeRetries : observed.retries;
      if (newRetries < 0) invalid();
      results.push(result); runs.push(observed.run); retries += newRetries;
      if (ordinal === 3) passThreeRetries = observed.retries;
      schemaVersion = observed.schemaVersion; sqliteVersion = observed.sqliteVersion;
      if (ordinal >= 3) {
        const semantic = semanticDigest(driver, lastPaths.eventStorePath, preflightInput.policy);
        const artifacts = artifactDigest([lastPaths.v1ProjectionRoot, lastPaths.v2ProjectionRoot, lastPaths.compatibilityRoot], preflightInput.policy);
        if (ordinal === 4 && (semantic !== semanticBefore || artifacts !== artifactsBefore)) invalid();
        semanticBefore = semantic; artifactsBefore = artifacts;
      }
    }
    const final = await preflightV2ShadowMigrationRehearsal(preflightInput, { driver });
    try { final.assertUnchanged(); if (canonicalJson(final.identity) !== canonicalJson(identity)) invalid(); }
    finally { final.close(); }
    assertPins(roots); build.assertUnchanged();
    const last = results[3]!, projectionLag = integer(Number(BigInt(manifest.terminalEventPosition) - BigInt(last.projection.v2.manifest.terminalEventPosition)));
    if (projectionLag !== 0) invalid();
    const counts = projectionCounts(last, preflightInput.policy);
    const elapsedMs = performance.now() - started, resources = readV2ShadowRehearsalResources(results, preflightInput.policy);
    const gates = [
      { name: "source-and-corpus-unchanged", status: "passed" as const, evidenceDigest: checksum(identity) },
      { name: "three-clean-deterministic", status: "passed" as const, evidenceDigest: checksum(runs.slice(0, 3)) },
      { name: "fourth-semantic-no-op", status: "passed" as const, evidenceDigest: checksum([semanticBefore, artifactsBefore]) },
      { name: "parity-and-compatibility-complete", status: "passed" as const, evidenceDigest: last.parity.reportChecksum },
      { name: "accepted-batch-geometry", status: "passed" as const, evidenceDigest: checksum({ maxBatchEvents: resources.maxBatchEvents, maxBatchBytes: resources.maxBatchBytes }) },
      { name: "supplied-test-results", status: config.tests.some((test: { failed: number }) => test.failed > 0) ? "failed" as const : "passed" as const, evidenceDigest: checksum(config.tests) },
    ];
    const evidence = buildV2ShadowMigrationEvidence({ schemaVersion: 1, commit: build.commit, nodeVersion: process.version, sqliteVersion,
      operatingSystem: process.platform, projectStoreSchemaVersion: schemaVersion, buildIdentityHash: build.buildIdentityHash,
      rolloutRevisionId: template.revisionId, migrationIdentity: last.migrationIdentity, configurationChecksum,
      policyChecksum: shadowMigrationPolicyChecksum(preflightInput.policy), sourceManifestChecksum: manifest.manifestChecksum,
      sourceBeforeChecksum: identity.sourceChecksum, sourceAfterChecksum: final.identity.sourceChecksum,
      counts: { ...counts, sourceEvents: manifest.eventCount, sourceArtifacts: manifest.legacyArtifacts.length,
        sourceScopeProvenanceRecords: manifest.eventCount, importedEvents: last.import.recordCount, retrievalQueries: corpus.queries.length },
      deterministicRuns: runs.slice(0, 3), noOpRun: runs[3],
      parity: { equal: last.parity.equalCount, expected: last.parity.expectedDifferenceCount, blocking: last.parity.blockingDivergenceCount, ruleIds: last.parity.matchedRuleIds },
      compatibility: { acknowledged: last.compatibility.acknowledgedCount, terminalPosition: last.compatibility.acknowledgedImportedPosition?.toString() ?? null,
        artifactSetChecksum: last.compatibility.artifactSetChecksum },
      performance: { elapsedMs, throughputPerSecond: elapsedMs > 0 ? results.reduce((sum, result) => sum + result.import.recordCount, 0) * 1000 / elapsedMs : 0,
        ...resources, retries, projectionLag, materializationLag: 0 }, tests: config.tests, reviews: config.reviews, gates, createdAt: new Date().toISOString() });
    build.assertUnchanged(); publishing = true;
    const receipt = await writeV2ShadowMigrationEvidence({ reservation, evidence });
    return Object.freeze({ evidenceChecksum: receipt.evidenceChecksum, migrationIdentity: evidence.migrationIdentity,
      gates: Object.freeze(evidence.gates.map(({ name, status }) => Object.freeze({ name, status }))), outputPathHash: receipt.outputPathHash });
  } catch (error) {
    failed = true;
    // The accepted writer stops its child even for a non-genuine carrier, and retains
    // the reservation. It never serializes a generic error or replaces an uncertain file.
    if (reservation && !publishing) { try { await writeV2ShadowMigrationEvidence({ reservation, failure: error }); } catch { /* redacted command refusal */ } }
    throw error;
  } finally { try { initial?.close(); } catch (error) { if (!failed) throw error; } }
}
