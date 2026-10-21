import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { types as utilTypes } from "node:util";
import { ShadowMigrationError, decodeShadowMigrationPolicyV1, shadowMigrationPolicyChecksum } from "../migration/v2-shadow-migration.contracts.js";
import type { VerifiedV1SourceCopy } from "../migration/v1-source-copy.js";
import { shadowMigrationPhaseMetadata, type ShadowMigrationInvocationDeadline, type ShadowMigrationReconciliation } from "../migration/v2-shadow-migration-runtime.js";
import { V2ImportedProjectionEventReader } from "../migration/v2-imported-event-reader.js";
import { V2ShadowProjectionPublisher, v1ProjectionBaselineChecksum, type ShadowProjectionInput, type ShadowProjectionResult, type V2ShadowProjectionPublisherOptions } from "../migration/v2-shadow-projection.js";
import { ImmutableProjectionBuilder } from "../projections/builder.js";
import { DefaultProjectionBuildCoordinator, V2ProjectionBuildCoordinator } from "../projections/coordinator.js";
import { SqliteProjectionEventReader } from "../projections/event-reader.js";
import { readVerifiedCanonicalProjectionSnapshot, type VerifiedCanonicalProjectionSnapshot } from "../projections/integrity.js";
import { PROJECTION_NAMES_V1, type ProjectionManifestV1 } from "../projections/manifest.js";
import type { ProjectionReaderLease } from "../projections/reader-lease.js";
import type { V2ProjectionReaderLease } from "../projections/v2-reader-lease.js";
import type { ProjectBinding } from "../projections/contracts.js";
import { SqliteRetrievalCandidateRepository } from "../retrieval/candidates.js";
import { V2SqliteRetrievalCandidateRepository } from "../retrieval/v2-candidates.js";
import { InternalRetrievalService, type RankedInternalRetrievalResult } from "../retrieval/service.js";
import { assertSealedEvaluationVectorDisabled, evaluateSealedRetrieval, parseSealedRetrievalEvaluationBundle, type SealedRetrievalEvaluationCorpusV2, type RetrievalEvaluationQueryV1 } from "../retrieval/evaluation.js";
import type { InternalRetrievalRequest } from "../retrieval/contracts.js";
import { SqliteV2ShadowMigrationRepository, type StoredExpectedDifferenceRule, type StoredParityReport, type V2ShadowMigrationTransaction } from "../storage/v2-shadow-migration.repository.js";
import { assertBoundSqliteConnectionIdentity } from "../storage/node-sqlite-driver.js";
import { decodeExpectedDifferenceRuleV1, type ExpectedDifferenceRuleV1 } from "./v2-expected-difference.js";
import { PROJECTION_NAMES, type ProjectionName } from "../projections/checksum.js";
import { canonicalJson } from "../serialization/canonical-json.js";

export type ParityClassification = "PARITY_EQUAL" | "PARITY_EXPECTED_DIFFERENCE" | "PARITY_BLOCKING_DIVERGENCE";
export interface RedactedParityFindingV1 {
  readonly schemaVersion: 1; readonly classification: ParityClassification; readonly category: string;
  readonly projection: ProjectionName; readonly rowIdentityHash: string; readonly fieldPathHash: string;
  readonly v1ValueHash: string; readonly v2ValueHash: string; readonly ruleId: string | null;
}
export interface SealedRetrievalParityV1 {
  readonly corpusVersion: string; readonly queryCount: number;
  readonly v1ThresholdsPassed: boolean; readonly v2ThresholdsPassed: boolean;
  readonly equalCount: number; readonly expectedDifferenceCount: number; readonly blockingDivergenceCount: number;
  readonly resultVectorChecksum: string;
}
export interface SnapshotParityReportV1 {
  readonly schemaVersion: 1; readonly rolloutRevisionId: string; readonly migrationIdentity: string;
  readonly packageChecksum: string; readonly comparedEventPosition: bigint; readonly comparedEventHash: string;
  readonly v1ManifestChecksum: string; readonly v2ManifestChecksum: string;
  readonly v1CoreChecksumsDigest: string; readonly v2CoreChecksumsDigest: string;
  readonly comparisonPolicyVersion: number; readonly equalCount: number; readonly expectedDifferenceCount: number;
  readonly blockingDivergenceCount: number; readonly findings: readonly RedactedParityFindingV1[];
  readonly matchedRuleIds: readonly string[]; readonly sealedRetrieval: SealedRetrievalParityV1; readonly reportChecksum: string;
}
export type SnapshotParityReportJsonV1 = Readonly<Omit<SnapshotParityReportV1, "comparedEventPosition"> & { comparedEventPosition: string }>;
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const MAX_FINDING_SAMPLES = 128;
const REPORT_KEYS = ["schemaVersion", "rolloutRevisionId", "migrationIdentity", "packageChecksum", "comparedEventPosition",
  "comparedEventHash", "v1ManifestChecksum", "v2ManifestChecksum", "v1CoreChecksumsDigest", "v2CoreChecksumsDigest",
  "comparisonPolicyVersion", "equalCount", "expectedDifferenceCount", "blockingDivergenceCount", "findings", "matchedRuleIds", "sealedRetrieval"] as const;
const FINDING_KEYS = ["schemaVersion", "classification", "category", "projection", "rowIdentityHash", "fieldPathHash", "v1ValueHash", "v2ValueHash", "ruleId"] as const;
const RETRIEVAL_KEYS = ["corpusVersion", "queryCount", "v1ThresholdsPassed", "v2ThresholdsPassed", "equalCount", "expectedDifferenceCount", "blockingDivergenceCount", "resultVectorChecksum"] as const;
const CATEGORIES = ["semantic-value", "representation", "identity", "authority", "scope", "event-chain-integrity", "privacy",
  "erasure", "duplicate-event", "lost-event", "ordering", "terminal-position", "terminal-hash", "core-checksum", "plaintext-leakage",
  "citation-integrity", "temporal-eligibility", "conflict-integrity", "retrieval-threshold"] as const;
function failure(): never { throw new ShadowMigrationError("MIGRATION_LEDGER_INTEGRITY_FAILURE"); }
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function record(
  input: unknown,
  keys: readonly string[],
  invocationDeadline?: ShadowMigrationInvocationDeadline,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || utilTypes.isProxy(input) || Array.isArray(input)) failure();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) failure();
  const actual = Reflect.ownKeys(input);
  if (actual.length !== keys.length) failure();
  const expectedKeys = new Set<string>();
  for (const key of keys) {
    checkInvocationDeadline(invocationDeadline);
    expectedKeys.add(key);
  }
  for (const key of actual) {
    checkInvocationDeadline(invocationDeadline);
    if (typeof key !== "string" || !expectedKeys.has(key)) failure();
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    checkInvocationDeadline(invocationDeadline);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) failure();
    result[key] = descriptor.value;
  }
  return result;
}
function array(
  input: unknown,
  maximum = 1_000_000,
  invocationDeadline?: ShadowMigrationInvocationDeadline,
): readonly unknown[] {
  if (typeof input !== "object" || input === null || utilTypes.isProxy(input) || !Array.isArray(input)
    || Object.getPrototypeOf(input) !== Array.prototype || input.length > maximum) failure();
  if (Reflect.ownKeys(input).length !== input.length + 1) failure();
  return Object.freeze(Array.from({ length: input.length }, (_, i) => {
    checkInvocationDeadline(invocationDeadline);
    const d = Object.getOwnPropertyDescriptor(input, String(i));
    if (!d || !d.enumerable || !("value" in d)) failure();
    return d.value as unknown;
  }));
}
function hash(value: unknown): string { if (typeof value !== "string" || !HASH.test(value)) failure(); return value; }
function count(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Object.is(value, -0)) failure();
  return Number(value);
}
function assertOwnJson(
  value: unknown,
  invocationDeadline?: ShadowMigrationInvocationDeadline,
  ancestors = new Set<object>(),
  depth = 0,
): void {
  checkInvocationDeadline(invocationDeadline);
  if (depth > 64) failure();
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value) || Object.is(value, -0)) failure(); return; }
  if (typeof value !== "object" || utilTypes.isProxy(value) || ancestors.has(value)) failure();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of array(value, 1_000_000, invocationDeadline)) {
        checkInvocationDeadline(invocationDeadline);
        assertOwnJson(item, invocationDeadline, ancestors, depth + 1);
      }
      return;
    }
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      checkInvocationDeadline(invocationDeadline);
      if (typeof key !== "string") failure();
    }
    for (const item of Object.values(record(value, keys as string[], invocationDeadline))) {
      checkInvocationDeadline(invocationDeadline);
      assertOwnJson(item, invocationDeadline, ancestors, depth + 1);
    }
  } finally { ancestors.delete(value); }
}
function checkInvocationDeadline(deadline: ShadowMigrationInvocationDeadline | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  const remaining = deadline.remainingMs();
  if (deadline.signal.aborted || !Number.isSafeInteger(remaining) || remaining < 1) {
    throw new ShadowMigrationError("MIGRATION_RETRY_EXHAUSTED");
  }
  return remaining;
}

export function authenticateSealedRetrievalSource(
  supplied: SealedRetrievalEvaluationCorpusV2,
  source: VerifiedV1SourceCopy,
  invocationDeadline?: ShadowMigrationInvocationDeadline,
): SealedRetrievalEvaluationCorpusV2 {
  checkInvocationDeadline(invocationDeadline);
  source.assertUnchanged();
  checkInvocationDeadline(invocationDeadline);
  assertOwnJson(supplied, invocationDeadline);
  const c = record(supplied, ["bundle", "sources", "queries", "baseline"], invocationDeadline);
  const corpus = parseSealedRetrievalEvaluationBundle(c.bundle,
    { schemaVersion: 2, corpusVersion: "retrieval-evaluation-v2", sources: c.sources },
    { schemaVersion: 2, corpusVersion: "retrieval-evaluation-v2", queries: c.queries }, c.baseline);
  checkInvocationDeadline(invocationDeadline);
  const binding = source.projectionSnapshot.binding;
  const sources = [] as typeof corpus.sources[number][];
  for (const candidate of corpus.sources) {
    checkInvocationDeadline(invocationDeadline);
    let matches = true;
    for (const key of BINDING_FIELDS) {
      checkInvocationDeadline(invocationDeadline);
      if (candidate.binding[key] !== binding[key]) matches = false;
    }
    if (matches) sources.push(candidate);
  }
  if (sources.length !== 1 || sources[0]!.events.length !== source.projectionSnapshot.eventCount) failure();
  let ordinal = 0;
  for (const event of source.projectionSnapshot.events()) {
    checkInvocationDeadline(invocationDeadline);
    const expected = sources[0]!.events[ordinal++];
    // The sealed artifact carries the exact stored envelope, including original
    // payload/witness strings; only the bigint transport fields become decimals.
    const json = Object.fromEntries(Object.entries(event).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]));
    if (!expected || canonicalJson(expected) !== canonicalJson(json)) failure();
    checkInvocationDeadline(invocationDeadline);
  }
  if (ordinal !== sources[0]!.events.length) failure();
  for (const query of corpus.queries) {
    checkInvocationDeadline(invocationDeadline);
    const request = queryRequest(query);
    if (BINDING_FIELDS.some(key => request.binding[key] !== binding[key])
      || request.consistency.requiredEventPosition !== source.projectionSnapshot.terminalEventPosition) failure();
    checkInvocationDeadline(invocationDeadline);
  }
  source.assertUnchanged();
  checkInvocationDeadline(invocationDeadline);
  return corpus;
}

function verifiedCorpus(input: SnapshotParityInput): SealedRetrievalEvaluationCorpusV2 {
  const supplied = record(input.sealedRetrieval, ["corpus"], input.invocationDeadline).corpus;
  return authenticateSealedRetrievalSource(
    supplied as SealedRetrievalEvaluationCorpusV2,
    input.source,
    input.invocationDeadline,
  );
}
function reportBody(input: unknown): Omit<SnapshotParityReportJsonV1, "reportChecksum"> {
  const v = record(input, REPORT_KEYS);
  if (v.schemaVersion !== 1 || typeof v.rolloutRevisionId !== "string" || !UUID.test(v.rolloutRevisionId)
    || typeof v.comparedEventPosition !== "bigint" || v.comparedEventPosition < 0n || v.comparedEventPosition > 9223372036854775807n) failure();
  const findings = Object.freeze(array(v.findings, MAX_FINDING_SAMPLES).map(inputFinding => {
    const f = record(inputFinding, FINDING_KEYS);
    if (f.schemaVersion !== 1 || typeof f.classification !== "string" || !["PARITY_EQUAL", "PARITY_EXPECTED_DIFFERENCE", "PARITY_BLOCKING_DIVERGENCE"].includes(f.classification)
      || typeof f.category !== "string" || !CATEGORIES.includes(f.category as typeof CATEGORIES[number])
      || typeof f.projection !== "string" || !PROJECTION_NAMES.includes(f.projection as ProjectionName)
      || !(f.ruleId === null || typeof f.ruleId === "string" && OPAQUE_ID.test(f.ruleId))
      || (f.classification === "PARITY_EXPECTED_DIFFERENCE") !== (f.ruleId !== null)) failure();
    return Object.freeze({ schemaVersion: 1, classification: f.classification as ParityClassification, category: f.category,
      projection: f.projection as ProjectionName, rowIdentityHash: hash(f.rowIdentityHash), fieldPathHash: hash(f.fieldPathHash),
      v1ValueHash: hash(f.v1ValueHash), v2ValueHash: hash(f.v2ValueHash), ruleId: f.ruleId as string | null });
  }));
  if (findings.length > MAX_FINDING_SAMPLES) failure();
  const matchedRuleIds = Object.freeze(array(v.matchedRuleIds).map(id => {
    if (typeof id !== "string" || !OPAQUE_ID.test(id)) failure(); return id;
  }));
  if (new Set(matchedRuleIds).size !== matchedRuleIds.length) failure();
  const r = record(v.sealedRetrieval, RETRIEVAL_KEYS);
  if (r.corpusVersion !== "retrieval-evaluation-v2" || typeof r.v1ThresholdsPassed !== "boolean" || typeof r.v2ThresholdsPassed !== "boolean") failure();
  const sealedRetrieval = Object.freeze({ corpusVersion: r.corpusVersion, queryCount: count(r.queryCount, 1),
    v1ThresholdsPassed: r.v1ThresholdsPassed, v2ThresholdsPassed: r.v2ThresholdsPassed, equalCount: count(r.equalCount),
    expectedDifferenceCount: count(r.expectedDifferenceCount), blockingDivergenceCount: count(r.blockingDivergenceCount), resultVectorChecksum: hash(r.resultVectorChecksum) });
  for (const [classification, key] of [["PARITY_EQUAL", "equalCount"], ["PARITY_EXPECTED_DIFFERENCE", "expectedDifferenceCount"],
    ["PARITY_BLOCKING_DIVERGENCE", "blockingDivergenceCount"]] as const) {
    if (findings.filter(finding => finding.classification === classification).length > count(v[key]) + sealedRetrieval[key]) failure();
  }
  if (findings.some(finding => finding.ruleId !== null && !matchedRuleIds.includes(finding.ruleId))) failure();
  return Object.freeze({ schemaVersion: 1, rolloutRevisionId: v.rolloutRevisionId, migrationIdentity: hash(v.migrationIdentity),
    packageChecksum: hash(v.packageChecksum), comparedEventPosition: v.comparedEventPosition.toString(), comparedEventHash: hash(v.comparedEventHash),
    v1ManifestChecksum: hash(v.v1ManifestChecksum), v2ManifestChecksum: hash(v.v2ManifestChecksum),
    v1CoreChecksumsDigest: hash(v.v1CoreChecksumsDigest), v2CoreChecksumsDigest: hash(v.v2CoreChecksumsDigest),
    comparisonPolicyVersion: count(v.comparisonPolicyVersion, 1), equalCount: count(v.equalCount), expectedDifferenceCount: count(v.expectedDifferenceCount),
    blockingDivergenceCount: count(v.blockingDivergenceCount), findings, matchedRuleIds, sealedRetrieval });
}
export function snapshotParityReportChecksum(report: Omit<SnapshotParityReportV1, "reportChecksum">): string {
  return digest(canonicalJson(reportBody(report)));
}
export function serializeSnapshotParityReport(report: SnapshotParityReportV1): SnapshotParityReportJsonV1 {
  const { reportChecksum, ...body } = record(report, [...REPORT_KEYS, "reportChecksum"]);
  const json = reportBody(body);
  if (hash(reportChecksum) !== digest(canonicalJson(json))) failure();
  return Object.freeze({ ...json, reportChecksum: reportChecksum as string });
}
function decodeStoredReportBody(input: unknown): Omit<SnapshotParityReportJsonV1, "reportChecksum"> {
  const body = record(input, REPORT_KEYS);
  const position = body.comparedEventPosition;
  if (typeof position !== "string" || !/^(0|[1-9][0-9]{0,18})$/u.test(position)) failure();
  return reportBody({ ...body, comparedEventPosition: BigInt(position) });
}

export interface SnapshotParityInput extends ShadowProjectionInput, Omit<V2ShadowProjectionPublisherOptions, "faultInjector" | "operationNow"> {
  readonly projections: ShadowProjectionResult;
  readonly runStartedAt: string;
  readonly rules: readonly ExpectedDifferenceRuleV1[];
  readonly sealedRetrieval: Readonly<{ corpus: SealedRetrievalEvaluationCorpusV2 }>;
  readonly faultInjector?: Readonly<{ hit(boundary: "after-report-before-phase4"): void | Promise<void> }>;
}
const BINDING_FIELDS = ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId"] as const;
const ROW_KEYS: Readonly<Record<ProjectionName, readonly string[]>> = {
  sessionTree: ["project_id", "session_id"], sessionCheckpoints: ["project_id", "session_id", "checkpoint_id"],
  canonicalItems: ["project_id", "item_id"], tasksFollowups: ["project_id", "follow_up_id"],
  artifactsFiles: ["project_id", "session_id", "artifact_id"], entityGraph: ["project_id", "relation"],
  lexicalChunks: ["project_id", "chunk_id"], retrievalFeedback: ["project_id", "feedback_id"],
};
export function parityValueHash(value: null | boolean | number | string | undefined): string {
  return digest("project-memory/v2-parity-value/v1\n" + canonicalJson(value === undefined ? ["absent"] : ["present", value]));
}
function rowIdentityKey(projection: ProjectionName, row: Readonly<Record<string, unknown>>): string {
  const fields = projection === "entityGraph" ? [...ROW_KEYS[projection], row.relation === "node" ? "entity_id" : row.relation === "alias" ? "alias_id" : "edge_id"] : ROW_KEYS[projection];
  const values = fields.map(key => { if (typeof row[key] !== "string") failure(); return row[key]; });
  return canonicalJson([projection, ...values]);
}
export function parityRowIdentityHash(projection: ProjectionName, row: Readonly<Record<string, unknown>>): string {
  return digest("project-memory/v2-parity-row/v1\n" + rowIdentityKey(projection, row));
}
function pathIdentity(path: string, directory: boolean) {
  const key = (v: string) => process.platform === "win32" ? v.toLowerCase() : v;
  if (!isAbsolute(path) || normalize(path) !== path || key(realpathSync.native(path)) !== key(path)) failure();
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) failure();
  return stat;
}
function overlaps(left: string, right: string): boolean {
  const child = relative(left, right);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}
function verifyTarget(input: SnapshotParityInput): void {
  input.source.assertUnchanged(); input.sealedPackage.assertUnchanged();
  const target = pathIdentity(input.eventStorePath, false);
  try {
    assertBoundSqliteConnectionIdentity(input.connection, input.eventStorePath,
      { device: String(target.dev), inode: String(target.ino) });
  } catch { failure(); }
  const roots = [input.source.sourceRoot, input.sealedPackage.rootPath, input.liveVaultRoot, dirname(input.liveEventStorePath), input.v1ProjectionDirectory, input.v2ProjectionDirectory];
  for (const root of roots) { pathIdentity(root, true); if (overlaps(root, input.eventStorePath)) failure(); }
  const source = pathIdentity(join(input.source.sourceRoot, input.source.manifest.database.relativePath), false);
  const live = pathIdentity(input.liveEventStorePath, false);
  const main = input.connection.prepare("PRAGMA database_list").all().find(row => row.name === "main");
  if (typeof main?.file !== "string") failure();
  const connected = pathIdentity(main.file, false);
  if (target.dev !== connected.dev || target.ino !== connected.ino || [source, live].some(other => target.dev === other.dev && target.ino === other.ino)) failure();
  for (const directory of [input.v1ProjectionDirectory, input.v2ProjectionDirectory]) {
    for (const root of roots.slice(0, 4)) if (overlaps(root, directory) || overlaps(directory, root)) failure();
  }
  if (overlaps(input.v1ProjectionDirectory, input.v2ProjectionDirectory) || overlaps(input.v2ProjectionDirectory, input.v1ProjectionDirectory)) failure();
}

function validateParityRules(
  input: SnapshotParityInput,
  policy: ReturnType<typeof decodeShadowMigrationPolicyV1>,
): readonly ExpectedDifferenceRuleV1[] {
  checkInvocationDeadline(input.invocationDeadline);
  const started = Date.parse(input.runStartedAt);
  if (!Number.isFinite(started) || new Date(started).toISOString() !== input.runStartedAt) failure();
  const decoded: ExpectedDifferenceRuleV1[] = [];
  for (const supplied of array(input.rules, 1_000_000, input.invocationDeadline)) {
    checkInvocationDeadline(input.invocationDeadline);
    decoded.push(decodeExpectedDifferenceRuleV1(supplied));
    checkInvocationDeadline(input.invocationDeadline);
  }
  const rules = Object.freeze(decoded);
  const ruleIds = new Set<string>();
  for (const rule of rules) {
    checkInvocationDeadline(input.invocationDeadline);
    if (ruleIds.has(rule.ruleId)
      || rule.policyVersion !== policy.expectedDifferencePolicyVersion
      || rule.rolloutRevisionId !== input.rolloutRevisionId
      || rule.migrationIdentity !== input.sealedPackage.migrationIdentity
      || Date.parse(rule.issuedAt) > started
      || Date.parse(rule.expiresAt) <= started
      || started - Date.parse(rule.issuedAt) > policy.maxExpectedDifferenceRuleAgeMs) {
      throw new ShadowMigrationError("PARITY_RULE_INVALID");
    }
    ruleIds.add(rule.ruleId);
    checkInvocationDeadline(input.invocationDeadline);
  }
  return rules;
}

function expectedStoredRules(
  input: SnapshotParityInput,
  rules: readonly ExpectedDifferenceRuleV1[],
): readonly StoredExpectedDifferenceRule[] {
  const projectId = input.source.projectionSnapshot.binding.projectId;
  const stored: StoredExpectedDifferenceRule[] = [];
  for (const rule of rules) {
    checkInvocationDeadline(input.invocationDeadline);
    const { schemaVersion: _, projection, rowIdentityHash, fieldPath, ...governance } = rule;
    stored.push(Object.freeze({ projectId, ...governance, projectionName: projection,
      selector: Object.freeze({ rowIdentityHash, fieldPath }) }));
    checkInvocationDeadline(input.invocationDeadline);
  }
  return Object.freeze(stored);
}

function parityManifestChecksums(input: SnapshotParityInput): readonly [string, string] {
  return Object.freeze([
    digest(canonicalJson(input.projections.v1.generation.manifest)),
    digest(canonicalJson(input.projections.v2.manifest)),
  ]);
}

function validatedParityTransaction<T>(
  input: SnapshotParityInput,
  policy: ReturnType<typeof decodeShadowMigrationPolicyV1>,
  callback: (
    tx: V2ShadowMigrationTransaction,
    phases: ReturnType<V2ShadowMigrationTransaction["readTransitions"]>,
    manifestChecksums: readonly [string, string],
    markWrite: () => void,
  ) => T,
  onCommitMayWrite?: () => void,
): T {
  checkInvocationDeadline(input.invocationDeadline);
  verifyTarget(input);
  checkInvocationDeadline(input.invocationDeadline);
  const binding = input.source.projectionSnapshot.binding;
  const packageManifest = input.sealedPackage.manifest;
  const v1Manifest = input.projections.v1.generation.manifest;
  const manifestChecksums = parityManifestChecksums(input);
  const repository = new SqliteV2ShadowMigrationRepository(input.connection);
  const result = repository.transact(binding.projectId, input.sealedPackage.migrationIdentity, tx => {
    checkInvocationDeadline(input.invocationDeadline);
    const run = tx.readRun();
    const phases = tx.readTransitions();
    checkInvocationDeadline(input.invocationDeadline);
    const phase3 = phases[3];
    const expectedPhase3 = shadowMigrationPhaseMetadata(input.sealedPackage.migrationIdentity, input.source.manifest.createdAt, 3);
    if (!run || run.rolloutRevisionId !== input.rolloutRevisionId || run.packageChecksum !== packageManifest.packageChecksum
      || run.sourceManifestChecksum !== input.source.manifest.manifestChecksum || run.sourceManifestChecksum !== packageManifest.sourceManifestChecksum
      || run.sourceTerminalPosition !== BigInt(packageManifest.terminalEventPosition) || run.sourceTerminalHash !== packageManifest.terminalEventHash
      || run.configurationChecksum !== packageManifest.configurationChecksum || run.buildIdentityHash !== packageManifest.buildIdentityHash
      || run.policyChecksum !== shadowMigrationPolicyChecksum(policy) || !phase3 || phase3.phase !== "projection-verified"
      || phase3.ordinal !== 3 || phase3.priorTransitionHash !== phases[2]?.transitionHash
      || phase3.attemptId !== expectedPhase3.attemptId || phase3.recordedAt !== expectedPhase3.recordedAt) failure();
    const revision = input.connection.prepare("SELECT v1_baseline_checksum,build_identity_hash,migration_identity_hash,configuration_checksum FROM rollout_revisions WHERE project_id=$p AND revision_id=$r")
      .get({ $p: binding.projectId, $r: run.rolloutRevisionId });
    checkInvocationDeadline(input.invocationDeadline);
    if (!revision || revision.v1_baseline_checksum !== v1ProjectionBaselineChecksum(v1Manifest)
      || revision.build_identity_hash !== run.buildIdentityHash || revision.migration_identity_hash !== run.migrationIdentity
      || revision.configuration_checksum !== run.configurationChecksum
      || phase3.evidenceDigest !== digest(canonicalJson({ v1ManifestChecksum: manifestChecksums[0], v2ManifestChecksum: manifestChecksums[1], v1BaselineChecksum: revision.v1_baseline_checksum }))) failure();
    checkInvocationDeadline(input.invocationDeadline);
    let wrote = false;
    const result = callback(tx, phases, manifestChecksums, () => { wrote = true; });
    checkInvocationDeadline(input.invocationDeadline);
    if (wrote) onCommitMayWrite?.();
    return result;
  });
  checkInvocationDeadline(input.invocationDeadline);
  verifyTarget(input);
  checkInvocationDeadline(input.invocationDeadline);
  return result;
}

/** Each request receives only a metadata facade; the V2 adapter retains its original private-image lease. */
export function createV2ParityRetrievalBridge(original: V2ProjectionReaderLease): Readonly<{ service: InternalRetrievalService; close(): void }> {
  if (original.manifest.schemaVersion !== 2) failure();
  let closed = false;
  const originals = new WeakMap<ProjectionReaderLease, V2ProjectionReaderLease>();
  const adapter = new V2SqliteRetrievalCandidateRepository();
  const { highestObservedGeneration: _, ...manifestFields } = original.manifest;
  const facadeManifest: ProjectionManifestV1 = Object.freeze({ ...manifestFields, schemaVersion: 1,
    databaseFile: `projections-1-${original.manifest.generation}.sqlite`,
    coreChecksums: Object.freeze(Object.fromEntries(PROJECTION_NAMES_V1.map(name => [name, original.manifest.coreChecksums[name]]))) as ProjectionManifestV1["coreChecksums"] });
  const service = new InternalRetrievalService({ projections: { async pin(binding) {
    if (closed || BINDING_FIELDS.some(key => binding[key] !== original.manifest[key])) failure();
    const view: ProjectionReaderLease = Object.freeze({ manifest: facadeManifest,
      get databasePath(): string { return failure(); }, close() { originals.delete(view); } });
    originals.set(view, original); return view;
  } }, candidates: { collectEligible(view, request) {
    const retained = originals.get(view); if (!retained || closed) failure();
    return adapter.collectEligible(retained, request);
  } } });
  return Object.freeze({ service, close() { if (!closed) { closed = true; original.close(); } } });
}
function queryRequest(query: RetrievalEvaluationQueryV1): InternalRetrievalRequest {
  const s = query.eligibleScope;
  const binding = Object.freeze(Object.fromEntries(BINDING_FIELDS.map(key => [key, key === "sessionId" ? null : s[key]]))) as unknown as ProjectBinding;
  const vector = Object.freeze({ enabled: false }); assertSealedEvaluationVectorDisabled(vector);
  return { binding, query: query.queryText, limit: 10, tokenBudget: 32768,
    consistency: { requiredEventPosition: BigInt(s.requiredEventPosition), deadlineMs: s.deadlineMs }, candidateLimit: 512,
    explain: false, includeGlobal: false, visibility: s.visibility, vector,
    ...(s.sessionId === null ? {} : { sessionId: s.sessionId }), ...(s.validAt === null ? {} : { validAt: s.validAt }),
    ...(s.knownAt === null ? {} : { knownAt: BigInt(s.knownAt) }) };
}
function retrievalVector(result: RankedInternalRetrievalResult) {
  return { terminalEventPosition: String(result.terminalEventPosition), publishedEventPosition: String(result.publishedEventPosition),
    truncated: result.truncated, conflictTruncated: result.conflictTruncated,
    conflicts: result.conflicts.map(({ conflictGroupId, totalMemberCount, selectedMemberCount, highImpact, truncated }) => ({ conflictGroupId, totalMemberCount, selectedMemberCount, highImpact, truncated })),
    items: result.items.map((item, rank) => ({ rank, id: item.id, kind: item.kind, projectId: item.projectId, workspaceId: item.workspaceId,
      branchScopeId: item.branchScopeId, branchRef: item.branchRef, sessionId: item.sessionId, visibility: item.visibility, status: item.status,
      sourceEventPosition: String(item.sourceEventPosition), knownFromEventPosition: String(item.knownFromEventPosition),
      validFrom: item.validFrom, validTo: item.validTo, freshness: item.freshness, anchor: item.anchor,
      conflictGroupId: item.conflictGroupId, supersedingItemId: item.supersedingItemId })) };
}

function reconstructedStoredReport(
  input: SnapshotParityInput,
  policy: ReturnType<typeof decodeShadowMigrationPolicyV1>,
  corpus: SealedRetrievalEvaluationCorpusV2,
  expectedRules: readonly StoredExpectedDifferenceRule[],
  stored: StoredParityReport,
  manifestChecksums: readonly [string, string],
): SnapshotParityReportV1 {
  const body = decodeStoredReportBody(stored.report);
  if (digest(canonicalJson(body)) !== stored.reportChecksum || stored.reportId !== stored.reportChecksum) failure();
  const report = Object.freeze({
    ...body,
    comparedEventPosition: BigInt(body.comparedEventPosition),
    reportChecksum: stored.reportChecksum,
  }) as SnapshotParityReportV1;
  serializeSnapshotParityReport(report);
  const expectedMetadata = shadowMigrationPhaseMetadata(input.sealedPackage.migrationIdentity, input.source.manifest.createdAt, 4);
  const expectedV1CoreDigest = digest(canonicalJson(input.projections.v1.generation.manifest.coreChecksums));
  const expectedV2CoreDigest = digest(canonicalJson(input.projections.v2.manifest.coreChecksums));
  let hasUnexpectedMatchedRule = false;
  for (const ruleId of report.matchedRuleIds) {
    checkInvocationDeadline(input.invocationDeadline);
    let expected = false;
    for (const rule of expectedRules) {
      checkInvocationDeadline(input.invocationDeadline);
      if (rule.ruleId === ruleId) expected = true;
    }
    if (!expected) hasUnexpectedMatchedRule = true;
  }
  if (stored.projectId !== input.source.projectionSnapshot.binding.projectId
    || stored.migrationIdentity !== input.sealedPackage.migrationIdentity
    || stored.packageChecksum !== input.sealedPackage.manifest.packageChecksum
    || stored.comparedEventPosition !== input.source.projectionSnapshot.terminalEventPosition
    || stored.comparedEventHash !== input.source.projectionSnapshot.terminalEventHash
    || stored.v1ManifestChecksum !== manifestChecksums[0] || stored.v2ManifestChecksum !== manifestChecksums[1]
    || stored.v1CoreChecksumsDigest !== expectedV1CoreDigest
    || stored.v2CoreChecksumsDigest !== expectedV2CoreDigest
    || report.v1CoreChecksumsDigest !== expectedV1CoreDigest
    || report.v2CoreChecksumsDigest !== expectedV2CoreDigest
    || report.v1CoreChecksumsDigest !== stored.v1CoreChecksumsDigest
    || report.v2CoreChecksumsDigest !== stored.v2CoreChecksumsDigest
    || stored.retrievalVectorChecksum !== report.sealedRetrieval.resultVectorChecksum
    || stored.equalCount !== report.equalCount || stored.expectedDifferenceCount !== report.expectedDifferenceCount
    || stored.blockingDivergenceCount !== report.blockingDivergenceCount || stored.recordedAt !== expectedMetadata.recordedAt
    || report.rolloutRevisionId !== input.rolloutRevisionId || report.migrationIdentity !== input.sealedPackage.migrationIdentity
    || report.packageChecksum !== input.sealedPackage.manifest.packageChecksum
    || report.comparedEventPosition !== input.source.projectionSnapshot.terminalEventPosition
    || report.comparedEventHash !== input.source.projectionSnapshot.terminalEventHash
    || report.v1ManifestChecksum !== manifestChecksums[0] || report.v2ManifestChecksum !== manifestChecksums[1]
    || report.comparisonPolicyVersion !== policy.expectedDifferencePolicyVersion
    || hasUnexpectedMatchedRule
    || report.sealedRetrieval.corpusVersion !== corpus.bundle.corpusVersion
    || report.sealedRetrieval.queryCount !== corpus.queries.length
    || !report.sealedRetrieval.v1ThresholdsPassed || !report.sealedRetrieval.v2ThresholdsPassed
    || report.blockingDivergenceCount !== 0 || report.sealedRetrieval.blockingDivergenceCount !== 0) failure();
  return report;
}

function unknownParityProof(code: "MIGRATION_OUTCOME_UNKNOWN" | "MIGRATION_RETRY_EXHAUSTED" = "MIGRATION_OUTCOME_UNKNOWN") {
  return Object.freeze({ status: "unknown" as const, safeErrorCode: code });
}

export async function reconcileV1V2Snapshots(
  input: SnapshotParityInput,
): Promise<ShadowMigrationReconciliation<SnapshotParityReportV1>> {
  let readingEvidence = false;
  try {
    checkInvocationDeadline(input.invocationDeadline);
    verifyTarget(input);
    const policy = decodeShadowMigrationPolicyV1(input.policy);
    const rules = validateParityRules(input, policy);
    const corpus = verifiedCorpus(input);
    checkInvocationDeadline(input.invocationDeadline);
    const publisher = new V2ShadowProjectionPublisher({
      driver: input.driver,
      connection: input.connection,
      eventStorePath: input.eventStorePath,
      liveEventStorePath: input.liveEventStorePath,
      liveVaultRoot: input.liveVaultRoot,
      v1ProjectionDirectory: input.v1ProjectionDirectory,
      v2ProjectionDirectory: input.v2ProjectionDirectory,
      policy: input.policy,
    });
    const projections = await publisher.reconcileV2(input);
    checkInvocationDeadline(input.invocationDeadline);
    verifyTarget(input);
    if (projections.status === "unknown") return unknownParityProof(
      projections.safeErrorCode === "MIGRATION_RETRY_EXHAUSTED" ? "MIGRATION_RETRY_EXHAUSTED" : "MIGRATION_OUTCOME_UNKNOWN",
    );
    if (projections.status !== "committed") return unknownParityProof();
    if (canonicalJson(projections.result) !== canonicalJson(input.projections)) failure();
    const expectedRules = expectedStoredRules(input, rules);
    readingEvidence = true;
    const proof = validatedParityTransaction(input, policy, (tx, phases, manifestChecksums) => {
      checkInvocationDeadline(input.invocationDeadline);
      const storedRules = tx.readExpectedDifferenceRules();
      const storedReport = tx.readParityReport();
      checkInvocationDeadline(input.invocationDeadline);
      const phase4 = phases[4];
      const byRuleId = new Map<string, StoredExpectedDifferenceRule>();
      for (const rule of expectedRules) {
        checkInvocationDeadline(input.invocationDeadline);
        byRuleId.set(rule.ruleId, rule);
      }
      for (const storedRule of storedRules) {
        checkInvocationDeadline(input.invocationDeadline);
        const expected = byRuleId.get(storedRule.ruleId);
        if (!expected || canonicalJson(storedRule) !== canonicalJson(expected)) failure();
        checkInvocationDeadline(input.invocationDeadline);
      }
      if (storedRules.length > expectedRules.length) failure();
      const allAbsent = storedRules.length === 0 && storedReport === null && phase4 === undefined;
      if (allAbsent) return Object.freeze({ status: "absent" as const });
      const report = storedReport === null ? undefined
        : reconstructedStoredReport(input, policy, corpus, expectedRules, storedReport, manifestChecksums);
      if (phase4 !== undefined) {
        const metadata = shadowMigrationPhaseMetadata(input.sealedPackage.migrationIdentity, input.source.manifest.createdAt, 4);
        if (phase4.phase !== "parity-complete" || phase4.ordinal !== 4
          || phase4.priorTransitionHash !== phases[3]!.transitionHash
          || phase4.attemptId !== metadata.attemptId || phase4.recordedAt !== metadata.recordedAt
          || (report !== undefined && phase4.evidenceDigest !== report.reportChecksum)) failure();
      }
      if (storedRules.length !== expectedRules.length || report === undefined || phase4 === undefined) return unknownParityProof();
      return Object.freeze({ status: "committed" as const, result: report });
    });
    checkInvocationDeadline(input.invocationDeadline);
    verifyTarget(input);
    authenticateSealedRetrievalSource(corpus, input.source, input.invocationDeadline);
    checkInvocationDeadline(input.invocationDeadline);
    return proof;
  } catch (error) {
    if (error instanceof ShadowMigrationError) {
      if (error.code === "MIGRATION_RETRY_EXHAUSTED") return unknownParityProof("MIGRATION_RETRY_EXHAUSTED");
      if (error.code === "MIGRATION_OUTCOME_UNKNOWN") return unknownParityProof();
      throw new ShadowMigrationError(error.code);
    }
    if (readingEvidence) return unknownParityProof();
    throw new ShadowMigrationError("PROJECTION_INTEGRITY_FAILURE");
  }
}

export async function compareV1V2Snapshots(input: SnapshotParityInput): Promise<SnapshotParityReportV1> {
  let v1Lease: ProjectionReaderLease | undefined;
  let bridge: ReturnType<typeof createV2ParityRetrievalBridge> | undefined;
  let failed = false;
  let mayHaveCommitted = false;
  try {
    checkInvocationDeadline(input.invocationDeadline);
    verifyTarget(input);
    checkInvocationDeadline(input.invocationDeadline);
    const policy = decodeShadowMigrationPolicyV1(input.policy);
    const rules = validateParityRules(input, policy);
    const corpus = verifiedCorpus(input);
    const binding = input.source.projectionSnapshot.binding, packageManifest = input.sealedPackage.manifest;
    const v1Manifest = input.projections.v1.generation.manifest, v2Manifest = input.projections.v2.manifest;
    const manifestChecksums = parityManifestChecksums(input);
    const transact = <T>(callback: (tx: V2ShadowMigrationTransaction, markWrite: () => void) => T): T => {
      return validatedParityTransaction(
        input,
        policy,
        (tx, _phases, _manifestChecksums, markWrite) => callback(tx, markWrite),
        () => { mayHaveCommitted = true; },
      );
    };
    transact(() => undefined);
    const nativeRemaining = checkInvocationDeadline(input.invocationDeadline);
    const busyTimeoutMs = nativeRemaining === undefined ? undefined : Math.min(5000, nativeRemaining);
    const imported = new V2ImportedProjectionEventReader({ driver: input.driver, eventStorePath: input.eventStorePath,
      sealedPackage: input.sealedPackage, sourceManifest: input.source.manifest,
      ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }) });
    const committed = await imported.openCommittedSnapshot(binding);
    let left: VerifiedCanonicalProjectionSnapshot, right: VerifiedCanonicalProjectionSnapshot;
    let snapshotFailure: unknown;
    try {
      checkInvocationDeadline(input.invocationDeadline);
      verifyTarget(input);
      const v1InspectionRemaining = checkInvocationDeadline(input.invocationDeadline);
      left = readVerifiedCanonicalProjectionSnapshot(binding, v1Manifest, { driver: input.driver, eventStorePath: input.eventStorePath,
        projectionDirectory: input.v1ProjectionDirectory,
        sourceSnapshot: input.source.projectionSnapshot,
        ...(v1InspectionRemaining === undefined ? {} : { busyTimeoutMs: Math.min(5000, v1InspectionRemaining) }) });
      const v2InspectionRemaining = checkInvocationDeadline(input.invocationDeadline);
      right = readVerifiedCanonicalProjectionSnapshot(binding, v2Manifest, { driver: input.driver, eventStorePath: input.eventStorePath,
        projectionDirectory: input.v2ProjectionDirectory, sourceSnapshot: committed,
        ...(v2InspectionRemaining === undefined ? {} : { busyTimeoutMs: Math.min(5000, v2InspectionRemaining) }) });
      checkInvocationDeadline(input.invocationDeadline);
    } catch (error) { snapshotFailure = error; throw error; }
    finally { try { committed.close(); } catch (error) { if (snapshotFailure === undefined) throw error; } }
    verifyTarget(input);
    checkInvocationDeadline(input.invocationDeadline);
    if (left.schemaVersion !== 1 || right.schemaVersion !== 2 || BINDING_FIELDS.some(key => left.binding[key] !== right.binding[key])
      || left.terminalEventPosition !== right.terminalEventPosition || left.terminalEventHash !== right.terminalEventHash
      || String(left.terminalEventPosition) !== packageManifest.terminalEventPosition || left.terminalEventHash !== packageManifest.terminalEventHash) failure();
    const samples: Record<ParityClassification, RedactedParityFindingV1[]> = { PARITY_EQUAL: [], PARITY_EXPECTED_DIFFERENCE: [], PARITY_BLOCKING_DIVERGENCE: [] };
    const rowCounts = { equalCount: 0, expectedDifferenceCount: 0, blockingDivergenceCount: 0 };
    const retrievalCounts = { equalCount: 0, expectedDifferenceCount: 0, blockingDivergenceCount: 0 };
    let currentCounts = rowCounts;
    const matched = new Set<string>();
    const finding = (projection: ProjectionName, rowIdentityHash: string, field: string, v1ValueHash: string, v2ValueHash: string, category: string) => {
      const matching = rules.filter(rule => rule.projection === projection && rule.rowIdentityHash === rowIdentityHash && rule.fieldPath === field
        && rule.category === category && rule.predicate.v1ValueHash === v1ValueHash && rule.predicate.v2ValueHash === v2ValueHash);
      if (matching.length > 1) throw new ShadowMigrationError("PARITY_RULE_INVALID");
      const equal = v1ValueHash === v2ValueHash, rule = equal ? undefined : matching[0];
      if (rule) matched.add(rule.ruleId);
      const value = Object.freeze({ schemaVersion: 1 as const, classification: equal ? "PARITY_EQUAL" as const : rule ? "PARITY_EXPECTED_DIFFERENCE" as const : "PARITY_BLOCKING_DIVERGENCE" as const,
        category, projection, rowIdentityHash, fieldPathHash: digest("project-memory/v2-parity-field/v1\n" + field), v1ValueHash, v2ValueHash, ruleId: rule?.ruleId ?? null });
      currentCounts[value.classification === "PARITY_EQUAL" ? "equalCount" : value.classification === "PARITY_EXPECTED_DIFFERENCE" ? "expectedDifferenceCount" : "blockingDivergenceCount"]++;
      if (samples[value.classification].length < MAX_FINDING_SAMPLES) samples[value.classification].push(value);
      return value.classification;
    };
    const latest = new Map<string, typeof right.rows.sessionCheckpoints[number]>();
    for (const row of right.rows.sessionCheckpoints) {
      checkInvocationDeadline(input.invocationDeadline);
      const key = String(row.session_id), prior = latest.get(key);
      if (!prior || BigInt(String(row.source_event_position)) > BigInt(String(prior.source_event_position))) latest.set(key, row);
    }
    for (const projection of PROJECTION_NAMES) {
      checkInvocationDeadline(input.invocationDeadline);
      if (projection === "sessionCheckpoints") continue; // Complete history and lifecycle already matched to authenticated source, independently of the V1 latest-only view.
      const v2Rows = projection === "sessionTree" ? [...latest.values()] : right.rows[projection];
      const l = new Map(left.rows[projection].map(row => [rowIdentityKey(projection, row), row]));
      const r = new Map(v2Rows.map(row => [rowIdentityKey(projection, row), row]));
      for (const key of [...new Set([...l.keys(), ...r.keys()])].sort()) {
        checkInvocationDeadline(input.invocationDeadline);
        const identityHash = digest("project-memory/v2-parity-row/v1\n" + key);
        const a = l.get(key), b = r.get(key);
        if (!a || !b) { finding(projection, identityHash, "row", parityValueHash(a ? true : undefined), parityValueHash(b ? true : undefined), "identity"); continue; }
        for (const field of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
          checkInvocationDeadline(input.invocationDeadline);
          // These V2-only columns were checked against the exact original source event by the integrity reader.
          if (field === "source_event_id" || field === "anchor") continue;
          const metadata = projection === "artifactsFiles" && ["symbol", "commit_hash", "heading"].includes(field);
          const descriptive = ["summary", "task_summary", "text"].includes(field);
          finding(projection, identityHash, field, parityValueHash(a[field]), parityValueHash(b[field]), metadata ? "representation" : descriptive ? "semantic-value" : "authority");
        }
      }
    }
    currentCounts = retrievalCounts;
    const v1Coordinator = new DefaultProjectionBuildCoordinator({ eventReader: new SqliteProjectionEventReader({ driver: input.driver,
      eventStorePath: join(input.source.sourceRoot, input.source.manifest.database.relativePath) }),
      builder: new ImmutableProjectionBuilder({ driver: input.driver, projectionDirectory: input.v1ProjectionDirectory }), projectionDirectory: input.v1ProjectionDirectory });
    const v2Coordinator = new V2ProjectionBuildCoordinator({ eventReader: imported,
      builder: new ImmutableProjectionBuilder({ driver: input.driver, projectionDirectory: input.v2ProjectionDirectory }), projectionDirectory: input.v2ProjectionDirectory });
    v1Lease = await v1Coordinator.leasePublished(binding);
    checkInvocationDeadline(input.invocationDeadline);
    verifyTarget(input);
    const original = await v2Coordinator.leasePublishedForEvaluation(binding);
    bridge = createV2ParityRetrievalBridge(original);
    checkInvocationDeadline(input.invocationDeadline);
    verifyTarget(input);
    if (canonicalJson(v1Lease.manifest) !== canonicalJson(v1Manifest) || canonicalJson(original.manifest) !== canonicalJson(v2Manifest)) failure();
    const retainedV1 = v1Lease;
    const v1Service = new InternalRetrievalService({ projections: { async pin(requestBinding) {
      if (BINDING_FIELDS.some(key => requestBinding[key] !== binding[key])) failure();
      return Object.freeze({ manifest: retainedV1.manifest, databasePath: retainedV1.databasePath, close() {} });
    } }, candidates: new SqliteRetrievalCandidateRepository() });
    let v1ThresholdsPassed = false, v2ThresholdsPassed = false;
    try { await evaluateSealedRetrieval(corpus, v1Service, input.invocationDeadline); v1ThresholdsPassed = true; }
    catch (error) { if (error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED") throw error; }
    checkInvocationDeadline(input.invocationDeadline);
    verifyTarget(input);
    try { await evaluateSealedRetrieval(corpus, bridge.service, input.invocationDeadline); v2ThresholdsPassed = true; }
    catch (error) { if (error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED") throw error; }
    checkInvocationDeadline(input.invocationDeadline);
    verifyTarget(input);
    const vectors: unknown[] = [];
    for (const query of corpus.queries) {
      checkInvocationDeadline(input.invocationDeadline);
      const request = queryRequest(query), id = digest(query.queryId);
      if (BINDING_FIELDS.some(key => request.binding[key] !== binding[key]) || request.consistency.requiredEventPosition !== left.terminalEventPosition) failure();
      let a: RankedInternalRetrievalResult | undefined, b: RankedInternalRetrievalResult | undefined;
      try { a = await v1Service.retrieve(request, input.invocationDeadline); }
      catch (error) { if (error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED") throw error; }
      checkInvocationDeadline(input.invocationDeadline);
      try { b = await bridge.service.retrieve(request, input.invocationDeadline); }
      catch (error) { if (error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED") throw error; }
      checkInvocationDeadline(input.invocationDeadline);
      verifyTarget(input);
      const av = a ? retrievalVector(a) : null, bv = b ? retrievalVector(b) : null;
      const ah = digest(canonicalJson(av)), bh = digest(canonicalJson(bv));
      const classification = finding("canonicalItems", id, "retrieval-result", ah, bh, "authority");
      if (!a || !b) finding("canonicalItems", id, "retrieval-available", parityValueHash(true), parityValueHash(false), "authority");
      const ac = digest(canonicalJson(a?.items.map(item => [item.id, item.anchor, String(item.sourceEventPosition)]) ?? null));
      const bc = digest(canonicalJson(b?.items.map(item => [item.id, item.anchor, String(item.sourceEventPosition)]) ?? null));
      finding("canonicalItems", id, "retrieval-citations", ac, bc, "citation-integrity");
      vectors.push({ queryIdHash: id, v1ResultHash: ah, v2ResultHash: bh, v1CitationHash: ac, v2CitationHash: bc, classification });
    }
    if (!v1ThresholdsPassed || !v2ThresholdsPassed) finding("canonicalItems", digest("retrieval-thresholds"), "retrieval-thresholds", parityValueHash(true), parityValueHash(false), "retrieval-threshold");
    const findings = Object.freeze([...samples.PARITY_BLOCKING_DIVERGENCE, ...samples.PARITY_EXPECTED_DIFFERENCE, ...samples.PARITY_EQUAL].slice(0, MAX_FINDING_SAMPLES));
    const body: Omit<SnapshotParityReportV1, "reportChecksum"> = Object.freeze({ schemaVersion: 1, rolloutRevisionId: input.rolloutRevisionId,
      migrationIdentity: input.sealedPackage.migrationIdentity, packageChecksum: packageManifest.packageChecksum,
      comparedEventPosition: left.terminalEventPosition, comparedEventHash: left.terminalEventHash,
      v1ManifestChecksum: manifestChecksums[0], v2ManifestChecksum: manifestChecksums[1], v1CoreChecksumsDigest: digest(canonicalJson(left.coreChecksums)),
      v2CoreChecksumsDigest: digest(canonicalJson(right.coreChecksums)), comparisonPolicyVersion: policy.expectedDifferencePolicyVersion,
      ...rowCounts, findings, matchedRuleIds: Object.freeze([...matched].sort()),
      sealedRetrieval: Object.freeze({ corpusVersion: corpus.bundle.corpusVersion, queryCount: corpus.queries.length, v1ThresholdsPassed, v2ThresholdsPassed,
        ...retrievalCounts, resultVectorChecksum: digest(canonicalJson(vectors)) }) });
    const report = Object.freeze({ ...body, reportChecksum: snapshotParityReportChecksum(body) });
    const { reportChecksum, ...jsonBody } = serializeSnapshotParityReport(report);
    const phase4Metadata = shadowMigrationPhaseMetadata(report.migrationIdentity, input.source.manifest.createdAt, 4);
    checkInvocationDeadline(input.invocationDeadline);
    verifyTarget(input);
    const rulesToStore = expectedStoredRules(input, rules);
    transact((tx, markWrite) => {
      const existingRules = tx.readExpectedDifferenceRules();
      checkInvocationDeadline(input.invocationDeadline);
      const existingByRuleId = new Map<string, StoredExpectedDifferenceRule>();
      for (const existing of existingRules) {
        checkInvocationDeadline(input.invocationDeadline);
        existingByRuleId.set(existing.ruleId, existing);
      }
      if (existingRules.length > rulesToStore.length) failure();
      for (const rule of rulesToStore) {
        checkInvocationDeadline(input.invocationDeadline);
        const existing = existingByRuleId.get(rule.ruleId);
        if (existing !== undefined) {
          if (canonicalJson(existing) !== canonicalJson(rule)) failure();
          continue;
        }
        markWrite();
        tx.insertExpectedDifferenceRules([rule]);
        checkInvocationDeadline(input.invocationDeadline);
      }
    });
    checkInvocationDeadline(input.invocationDeadline);
    const stored: StoredParityReport = { projectId: binding.projectId, migrationIdentity: report.migrationIdentity, reportId: reportChecksum,
      packageChecksum: report.packageChecksum, comparedEventPosition: report.comparedEventPosition, comparedEventHash: report.comparedEventHash,
      v1ManifestChecksum: report.v1ManifestChecksum, v2ManifestChecksum: report.v2ManifestChecksum,
      v1CoreChecksumsDigest: report.v1CoreChecksumsDigest, v2CoreChecksumsDigest: report.v2CoreChecksumsDigest,
      retrievalVectorChecksum: report.sealedRetrieval.resultVectorChecksum, equalCount: report.equalCount,
      expectedDifferenceCount: report.expectedDifferenceCount, blockingDivergenceCount: report.blockingDivergenceCount,
      report: jsonBody, reportChecksum, recordedAt: phase4Metadata.recordedAt };
    checkInvocationDeadline(input.invocationDeadline);
    verifyTarget(input);
    transact((tx, markWrite) => {
      const existing = tx.readParityReport();
      checkInvocationDeadline(input.invocationDeadline);
      if (existing) {
        const adoptedBody = decodeStoredReportBody(existing.report);
        if (digest(canonicalJson(adoptedBody)) !== existing.reportChecksum) failure();
        for (const key of Object.keys(stored) as (keyof StoredParityReport)[]) {
          if (key === "report") { if (canonicalJson(adoptedBody) !== canonicalJson(stored.report)) failure(); }
          else if (existing[key] !== stored[key]) failure();
        }
      } else {
        checkInvocationDeadline(input.invocationDeadline);
        markWrite();
        tx.insertParityReport(stored);
        checkInvocationDeadline(input.invocationDeadline);
      }
    });
    checkInvocationDeadline(input.invocationDeadline);
    verifyTarget(input);
    const hookImages = input.faultInjector === undefined ? [] : [retainedV1.databasePath, input.projections.v2.databasePath]
      .map(path => ({ path, identity: pathIdentity(path, false) }));
    const pending = input.faultInjector?.hit("after-report-before-phase4");
    if (pending !== undefined) await pending;
    checkInvocationDeadline(input.invocationDeadline);
    verifyTarget(input);
    input.source.assertUnchanged(); input.sealedPackage.assertUnchanged();
    for (const image of hookImages) {
      checkInvocationDeadline(input.invocationDeadline);
      const current = pathIdentity(image.path, false);
      if (["dev", "ino", "size", "ctimeNs", "mtimeNs"].some(key =>
        current[key as keyof typeof current] !== image.identity[key as keyof typeof current])) failure();
    }
    if (canonicalJson(retainedV1.manifest) !== canonicalJson(v1Manifest) || canonicalJson(original.manifest) !== canonicalJson(v2Manifest)) failure();
    checkInvocationDeadline(input.invocationDeadline);
    if (report.blockingDivergenceCount || report.sealedRetrieval.blockingDivergenceCount) throw new ShadowMigrationError("PARITY_BLOCKING_DIVERGENCE");
    verifyTarget(input);
    transact((tx, markWrite) => {
      const phases = tx.readTransitions();
      checkInvocationDeadline(input.invocationDeadline);
      if (phases[4]) {
        if (phases[4].phase !== "parity-complete" || phases[4].ordinal !== 4
          || phases[4].priorTransitionHash !== phases[3]!.transitionHash
          || phases[4].evidenceDigest !== reportChecksum || phases[4].attemptId !== phase4Metadata.attemptId
          || phases[4].recordedAt !== phase4Metadata.recordedAt) failure();
        return;
      }
      const transition = { projectId: binding.projectId, migrationIdentity: report.migrationIdentity, ordinal: 4,
        attemptId: phase4Metadata.attemptId, phase: "parity-complete" as const, priorTransitionHash: phases[3]!.transitionHash,
        evidenceDigest: reportChecksum, recordedAt: phase4Metadata.recordedAt };
      checkInvocationDeadline(input.invocationDeadline);
      markWrite();
      tx.appendTransition({ ...transition, transitionHash: digest("project-memory/v2-shadow-migration-transition/v1\n" + canonicalJson(transition)) });
      checkInvocationDeadline(input.invocationDeadline);
    });
    checkInvocationDeadline(input.invocationDeadline);
    verifyTarget(input);
    return report;
  } catch (error) {
    failed = true;
    if (error instanceof ShadowMigrationError) {
      if (mayHaveCommitted && error.code === "MIGRATION_RETRY_EXHAUSTED") throw new ShadowMigrationError("MIGRATION_OUTCOME_UNKNOWN");
      throw new ShadowMigrationError(error.code);
    }
    if (mayHaveCommitted) throw new ShadowMigrationError("MIGRATION_OUTCOME_UNKNOWN");
    throw new ShadowMigrationError("PROJECTION_INTEGRITY_FAILURE");
  } finally {
    let closeFailed = false;
    try { bridge?.close(); } catch { closeFailed = true; }
    try { v1Lease?.close(); } catch { closeFailed = true; }
    // Attempt every owned close, preserve an existing typed failure, and never
    // expose raw storage/lease diagnostics from an otherwise successful operation.
    if (closeFailed && !failed) throw new ShadowMigrationError(mayHaveCommitted ? "MIGRATION_OUTCOME_UNKNOWN" : "PROJECTION_INTEGRITY_FAILURE");
    if (!failed && !closeFailed) {
      try { checkInvocationDeadline(input.invocationDeadline); }
      catch { throw new ShadowMigrationError(mayHaveCommitted ? "MIGRATION_OUTCOME_UNKNOWN" : "MIGRATION_RETRY_EXHAUSTED"); }
    }
  }
}
