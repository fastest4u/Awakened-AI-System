import { isAbsolute, win32 } from "node:path";
import type { WorkspaceId } from "../../identity/contracts.js";
import {
  exactRecord,
  parseBoundedString,
  parseCanonicalTimestamp,
  parseDecimalString,
  parseEnum,
  parseInteger,
  parseLifecycleId,
  parseNullableBoundedString,
  parseNullableUuid,
  strictArray,
  strictRecord,
  type CheckpointId,
  type AdapterSessionId,
  type ChildSessionState,
  type EvidenceBatchId,
  type MaterialConfidence,
  type SessionId,
} from "./identifiers.js";
import { LifecycleError } from "../errors.js";
import { canonicalJson } from "../../serialization/canonical-json.js";

export const CHECKPOINT_MAX_CANONICAL_BYTES = 256 * 1024;
export const CHECKPOINT_EVIDENCE_COVERAGE_MAX_CANONICAL_BYTES = 192 * 1024;
export const CHECKPOINT_MAX_TASK_SUMMARY_SCALARS = 2_000;
export const CHECKPOINT_MAX_LIST_ENTRIES = 100;
export const CHECKPOINT_MAX_MATERIAL_ENTRIES = 200;
export const CHECKPOINT_MAX_PATH_SCALARS = 512;
export const CHECKPOINT_MAX_FIELD_SCALARS = 4_000;
export const CHECKPOINT_MAX_MISSING_INTERVALS = 200;

const CONFIDENCE = ["high", "medium", "low", "guess"] as const;
const FILE_ACTIONS = ["created", "modified", "deleted", "observed", "renamed"] as const;
const EXIT_CLASSIFICATIONS = ["passed", "failed", "unavailable", "not-run"] as const;
const CHILD_STATES = ["active", "completion-proposed", "completed", "suspended", "transferred"] as const;
const CHECKPOINT_CONTENT_KEYS = [
  "taskSummary",
  "completedItems",
  "inProgressItems",
  "blockers",
  "nextActions",
  "decisions",
  "assumptions",
  "unresolvedConflicts",
  "filesTouched",
  "artifactReferences",
  "sourceReferences",
  "commandResults",
  "testResults",
  "materialClaims",
] as const;
const LOWER_HASH = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DRIVE_QUALIFIED = /^[A-Za-z]:/;
const EXTERNAL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export interface CheckpointTextItemV1 {
  readonly summary: string;
  readonly confidence: MaterialConfidence;
}

export interface CheckpointFileV1 {
  readonly path: string;
  readonly action: (typeof FILE_ACTIONS)[number];
  readonly contentHash: string | null;
  readonly branchRef: string | null;
  readonly confidence: MaterialConfidence;
}

export interface CheckpointArtifactReferenceV1 {
  readonly artifactId: string;
  readonly path: string;
  readonly summary: string;
  readonly contentHash: string;
  readonly confidence: MaterialConfidence;
}

export interface CheckpointSourceReferenceV1 {
  readonly sourceId: string;
  readonly path: string;
  readonly summary: string;
  readonly contentHash: string | null;
  readonly confidence: MaterialConfidence;
}

export interface KeyedOutputFingerprintV1 {
  readonly fingerprintSchemaVersion: 1;
  readonly fingerprintKeyId: string;
  readonly fingerprintDomain: string;
  readonly fingerprint: string;
}

export interface CheckpointExecutionResultV1 {
  readonly label: string;
  readonly result: string;
  readonly exitClassification: (typeof EXIT_CLASSIFICATIONS)[number];
  readonly outputFingerprint: KeyedOutputFingerprintV1 | null;
  readonly artifactReference: string | null;
  readonly confidence: MaterialConfidence;
}

export interface CheckpointMaterialClaimV1 {
  readonly claimId: string;
  readonly summary: string;
  readonly evidenceReferences: readonly string[];
  readonly confidence: MaterialConfidence;
}

export interface SourceStateFingerprintV1 {
  readonly sourceStateScopeVersion: 1;
  readonly workspaceId: WorkspaceId;
  readonly branchRef: string | null;
  readonly headCommit: string | null;
  readonly dirtyWorktreeFingerprint: string;
}

export interface CheckpointChildSummaryV1 {
  readonly childSessionId: SessionId;
  readonly state: ChildSessionState;
  readonly lastEventPosition: string;
  readonly streamVersion: string;
  readonly latestCheckpointId: CheckpointId | null;
}

export interface MissingOrdinalIntervalV1 {
  readonly firstOrdinal: string;
  readonly lastOrdinal: string;
}

export interface CheckpointEvidenceCoverageV1 {
  readonly captureMode: "coverage-only";
  readonly contentRetained: false;
  readonly highestContiguousOrdinal: string | null;
  readonly missingIntervals: readonly MissingOrdinalIntervalV1[];
}

export interface CheckpointDraftV1 {
  readonly checkpointVersion: 1;
  readonly taskSummary: string;
  readonly completedItems: readonly CheckpointTextItemV1[];
  readonly inProgressItems: readonly CheckpointTextItemV1[];
  readonly blockers: readonly CheckpointTextItemV1[];
  readonly nextActions: readonly CheckpointTextItemV1[];
  readonly decisions: readonly CheckpointTextItemV1[];
  readonly assumptions: readonly CheckpointTextItemV1[];
  readonly unresolvedConflicts: readonly CheckpointTextItemV1[];
  readonly filesTouched: readonly CheckpointFileV1[];
  readonly artifactReferences: readonly CheckpointArtifactReferenceV1[];
  readonly sourceReferences: readonly CheckpointSourceReferenceV1[];
  readonly commandResults: readonly CheckpointExecutionResultV1[];
  readonly testResults: readonly CheckpointExecutionResultV1[];
  readonly materialClaims: readonly CheckpointMaterialClaimV1[];
}

export interface CheckpointV1 extends CheckpointDraftV1 {
  readonly checkpointId: CheckpointId;
  readonly sessionId: SessionId;
  readonly parentSessionId: SessionId | null;
  readonly baseEventPosition: string;
  readonly checkpointEventPosition: string;
  readonly createdAt: string;
  readonly creatorAgentId: string;
  readonly creatorClientInstanceId: string;
  readonly sourceState: SourceStateFingerprintV1;
  readonly childSummaries: readonly CheckpointChildSummaryV1[];
  readonly evidenceCoverage: CheckpointEvidenceCoverageV1;
}

export interface CheckpointAdapterCoverageV2 {
  readonly adapterSessionId: AdapterSessionId;
  readonly coverageFirstOrdinal: "0";
  readonly coverageLastOrdinal: string;
  readonly highestContiguousOrdinal: string | null;
  readonly missingIntervals: readonly MissingOrdinalIntervalV1[];
  readonly frameFingerprintAlgorithm: "hmac-sha256";
  readonly frameFingerprintSchemaVersion: 1;
  readonly frameFingerprintKeyId: string;
  readonly frameFingerprintDomain: "pm-evidence-frame-v1";
  readonly coverageFingerprintAlgorithm: "hmac-sha256";
  readonly coverageFingerprintSchemaVersion: 1;
  readonly coverageFingerprintKeyId: string;
  readonly coverageFingerprintDomain: "pm-evidence-coverage-v1";
  readonly coverageFingerprint: string;
  readonly latestBatchId: EvidenceBatchId;
  readonly latestBatchEventPosition: string;
}

export interface CheckpointEvidenceCoverageV2 {
  readonly coverageVersion: 2;
  readonly captureMode: "coverage-only";
  readonly contentRetained: false;
  readonly adapterSessions: readonly CheckpointAdapterCoverageV2[];
}

export interface CheckpointDraftV2 extends Omit<CheckpointDraftV1, "checkpointVersion"> {
  readonly checkpointVersion: 2;
}

export interface CheckpointV2
  extends Omit<CheckpointV1, "checkpointVersion" | "evidenceCoverage"> {
  readonly checkpointVersion: 2;
  readonly evidenceCoverage: CheckpointEvidenceCoverageV2;
}

export type CheckpointDraft = CheckpointDraftV1 | CheckpointDraftV2;
export type Checkpoint = CheckpointV1 | CheckpointV2;

function invalid(field: string): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
}

function hash(value: unknown, field: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !LOWER_HASH.test(value)) invalid(field);
  return value;
}

function projectPath(value: unknown, field: string): string {
  const decoded = parseBoundedString(value, field, CHECKPOINT_MAX_PATH_SCALARS);
  if (
    decoded.includes("\0")
    || isAbsolute(decoded)
    || win32.isAbsolute(decoded)
    || DRIVE_QUALIFIED.test(decoded)
    || EXTERNAL_SCHEME.test(decoded)
    || decoded.startsWith("/")
    || decoded.startsWith("\\")
  ) invalid(field);
  const segments = decoded.split(/[\\/]/u);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) invalid(field);
  return decoded;
}

function confidence(value: unknown, field: string): MaterialConfidence {
  return parseEnum(value, CONFIDENCE, field);
}

function textItem(value: unknown, field: string): CheckpointTextItemV1 {
  const item = exactRecord(value, ["summary", "confidence"], field);
  return Object.freeze({
    summary: parseBoundedString(item.summary, `${field}.summary`, CHECKPOINT_MAX_FIELD_SCALARS),
    confidence: confidence(item.confidence, `${field}.confidence`),
  });
}

function boundedArray<T>(
  value: unknown,
  field: string,
  maximum: number,
  decode: (item: unknown, field: string) => T,
): readonly T[] {
  const values = strictArray(value, field);
  if (values.length > maximum) invalid(field);
  return Object.freeze(values.map((item, index) => decode(item, `${field}[${index}]`)));
}

function file(value: unknown, field: string): CheckpointFileV1 {
  const item = exactRecord(value, ["path", "action", "contentHash", "branchRef", "confidence"], field);
  return Object.freeze({
    path: projectPath(item.path, `${field}.path`),
    action: parseEnum(item.action, FILE_ACTIONS, `${field}.action`),
    contentHash: hash(item.contentHash, `${field}.contentHash`, true),
    branchRef: parseNullableBoundedString(item.branchRef, `${field}.branchRef`, 1_024),
    confidence: confidence(item.confidence, `${field}.confidence`),
  });
}

function artifact(value: unknown, field: string): CheckpointArtifactReferenceV1 {
  const item = exactRecord(value, ["artifactId", "path", "summary", "contentHash", "confidence"], field);
  return Object.freeze({
    artifactId: parseLifecycleId(item.artifactId, `${field}.artifactId`),
    path: projectPath(item.path, `${field}.path`),
    summary: parseBoundedString(item.summary, `${field}.summary`, CHECKPOINT_MAX_FIELD_SCALARS),
    contentHash: hash(item.contentHash, `${field}.contentHash`) as string,
    confidence: confidence(item.confidence, `${field}.confidence`),
  });
}

function source(value: unknown, field: string): CheckpointSourceReferenceV1 {
  const item = exactRecord(value, ["sourceId", "path", "summary", "contentHash", "confidence"], field);
  return Object.freeze({
    sourceId: parseLifecycleId(item.sourceId, `${field}.sourceId`),
    path: projectPath(item.path, `${field}.path`),
    summary: parseBoundedString(item.summary, `${field}.summary`, CHECKPOINT_MAX_FIELD_SCALARS),
    contentHash: hash(item.contentHash, `${field}.contentHash`, true),
    confidence: confidence(item.confidence, `${field}.confidence`),
  });
}

function outputFingerprint(value: unknown, field: string): KeyedOutputFingerprintV1 | null {
  if (value === null) return null;
  const item = exactRecord(value, [
    "fingerprintSchemaVersion",
    "fingerprintKeyId",
    "fingerprintDomain",
    "fingerprint",
  ], field);
  if (item.fingerprintSchemaVersion !== 1) invalid(`${field}.fingerprintSchemaVersion`);
  return Object.freeze({
    fingerprintSchemaVersion: 1,
    fingerprintKeyId: parseBoundedString(item.fingerprintKeyId, `${field}.fingerprintKeyId`, 128),
    fingerprintDomain: parseBoundedString(item.fingerprintDomain, `${field}.fingerprintDomain`, 128),
    fingerprint: hash(item.fingerprint, `${field}.fingerprint`) as string,
  });
}

function execution(value: unknown, field: string): CheckpointExecutionResultV1 {
  const item = exactRecord(value, [
    "label",
    "result",
    "exitClassification",
    "outputFingerprint",
    "artifactReference",
    "confidence",
  ], field);
  return Object.freeze({
    label: parseBoundedString(item.label, `${field}.label`, CHECKPOINT_MAX_FIELD_SCALARS),
    result: parseBoundedString(item.result, `${field}.result`, CHECKPOINT_MAX_FIELD_SCALARS),
    exitClassification: parseEnum(item.exitClassification, EXIT_CLASSIFICATIONS, `${field}.exitClassification`),
    outputFingerprint: outputFingerprint(item.outputFingerprint, `${field}.outputFingerprint`),
    artifactReference: parseNullableUuid(item.artifactReference, `${field}.artifactReference`),
    confidence: confidence(item.confidence, `${field}.confidence`),
  });
}

function claim(value: unknown, field: string): CheckpointMaterialClaimV1 {
  const item = exactRecord(value, ["claimId", "summary", "evidenceReferences", "confidence"], field);
  const references = strictArray(item.evidenceReferences, `${field}.evidenceReferences`);
  if (references.length > CHECKPOINT_MAX_LIST_ENTRIES) invalid(`${field}.evidenceReferences`);
  return Object.freeze({
    claimId: parseLifecycleId(item.claimId, `${field}.claimId`),
    summary: parseBoundedString(item.summary, `${field}.summary`, CHECKPOINT_MAX_FIELD_SCALARS),
    evidenceReferences: Object.freeze(references.map((reference, index) =>
      parseBoundedString(reference, `${field}.evidenceReferences[${index}]`, 512))),
    confidence: confidence(item.confidence, `${field}.confidence`),
  });
}

function sourceState(value: unknown): SourceStateFingerprintV1 {
  const state = exactRecord(value, [
    "sourceStateScopeVersion",
    "workspaceId",
    "branchRef",
    "headCommit",
    "dirtyWorktreeFingerprint",
  ], "sourceState");
  if (state.sourceStateScopeVersion !== 1) invalid("sourceState.sourceStateScopeVersion");
  const headCommit = state.headCommit === null ? null : state.headCommit;
  if (headCommit !== null && (typeof headCommit !== "string" || !GIT_OBJECT_ID.test(headCommit))) {
    invalid("sourceState.headCommit");
  }
  return Object.freeze({
    sourceStateScopeVersion: 1,
    workspaceId: hash(state.workspaceId, "sourceState.workspaceId") as WorkspaceId,
    branchRef: parseNullableBoundedString(state.branchRef, "sourceState.branchRef", 1_024),
    headCommit: headCommit as string | null,
    dirtyWorktreeFingerprint: hash(state.dirtyWorktreeFingerprint, "sourceState.dirtyWorktreeFingerprint") as string,
  });
}

function childSummary(value: unknown, field: string): CheckpointChildSummaryV1 {
  const child = exactRecord(value, [
    "childSessionId",
    "state",
    "lastEventPosition",
    "streamVersion",
    "latestCheckpointId",
  ], field);
  return Object.freeze({
    childSessionId: parseLifecycleId<SessionId>(child.childSessionId, `${field}.childSessionId`),
    state: parseEnum(child.state, CHILD_STATES, `${field}.state`),
    lastEventPosition: parseDecimalString(child.lastEventPosition, `${field}.lastEventPosition`),
    streamVersion: parseDecimalString(child.streamVersion, `${field}.streamVersion`),
    latestCheckpointId: parseNullableUuid<CheckpointId>(child.latestCheckpointId, `${field}.latestCheckpointId`),
  });
}

function interval(value: unknown, field: string): MissingOrdinalIntervalV1 {
  const item = exactRecord(value, ["firstOrdinal", "lastOrdinal"], field);
  const firstOrdinal = parseDecimalString(item.firstOrdinal, `${field}.firstOrdinal`);
  const lastOrdinal = parseDecimalString(item.lastOrdinal, `${field}.lastOrdinal`);
  if (BigInt(firstOrdinal) > BigInt(lastOrdinal)) invalid(field);
  return Object.freeze({ firstOrdinal, lastOrdinal });
}

function evidenceCoverage(value: unknown): CheckpointEvidenceCoverageV1 {
  const coverage = exactRecord(
    value,
    ["captureMode", "contentRetained", "highestContiguousOrdinal", "missingIntervals"],
    "evidenceCoverage",
  );
  const source = strictArray(coverage.missingIntervals, "evidenceCoverage.missingIntervals");
  if (source.length > CHECKPOINT_MAX_MISSING_INTERVALS) {
    throw new LifecycleError("EVIDENCE_COVERAGE_TOO_FRAGMENTED");
  }
  if (coverage.captureMode !== "coverage-only") invalid("evidenceCoverage.captureMode");
  if (coverage.contentRetained !== false) invalid("evidenceCoverage.contentRetained");
  const intervals = source.map((item, index) => interval(item, `evidenceCoverage.missingIntervals[${index}]`));
  const highestContiguousOrdinal = coverage.highestContiguousOrdinal === null
    ? null
    : parseDecimalString(coverage.highestContiguousOrdinal, "evidenceCoverage.highestContiguousOrdinal");
  for (let index = 1; index < intervals.length; index += 1) {
    const previous = intervals[index - 1];
    const current = intervals[index];
    if (previous === undefined || current === undefined) invalid("evidenceCoverage.missingIntervals");
    if (BigInt(current.firstOrdinal) <= BigInt(previous.lastOrdinal) + 1n) {
      invalid("evidenceCoverage.missingIntervals");
    }
  }
  const firstMissingInterval = intervals[0];
  if (
    firstMissingInterval !== undefined
    && BigInt(firstMissingInterval.firstOrdinal) !== (
      highestContiguousOrdinal === null ? 0n : BigInt(highestContiguousOrdinal) + 1n
    )
  ) invalid("evidenceCoverage.missingIntervals");
  return Object.freeze({
    captureMode: "coverage-only",
    contentRetained: false,
    highestContiguousOrdinal,
    missingIntervals: Object.freeze(intervals),
  });
}

type CheckpointContentV1 = Omit<CheckpointDraftV1, "checkpointVersion">;

function decodeCheckpointContent(checkpoint: Record<string, unknown>): CheckpointContentV1 {
  const completedItems = boundedArray(checkpoint.completedItems, "completedItems", CHECKPOINT_MAX_LIST_ENTRIES, textItem);
  const inProgressItems = boundedArray(checkpoint.inProgressItems, "inProgressItems", CHECKPOINT_MAX_LIST_ENTRIES, textItem);
  const blockers = boundedArray(checkpoint.blockers, "blockers", CHECKPOINT_MAX_LIST_ENTRIES, textItem);
  const nextActions = boundedArray(checkpoint.nextActions, "nextActions", CHECKPOINT_MAX_LIST_ENTRIES, textItem);
  const decisions = boundedArray(checkpoint.decisions, "decisions", CHECKPOINT_MAX_LIST_ENTRIES, textItem);
  const assumptions = boundedArray(checkpoint.assumptions, "assumptions", CHECKPOINT_MAX_LIST_ENTRIES, textItem);
  const unresolvedConflicts = boundedArray(checkpoint.unresolvedConflicts, "unresolvedConflicts", CHECKPOINT_MAX_LIST_ENTRIES, textItem);
  const filesTouched = boundedArray(checkpoint.filesTouched, "filesTouched", CHECKPOINT_MAX_MATERIAL_ENTRIES, file);
  const artifactReferences = boundedArray(checkpoint.artifactReferences, "artifactReferences", CHECKPOINT_MAX_MATERIAL_ENTRIES, artifact);
  const sourceReferences = boundedArray(checkpoint.sourceReferences, "sourceReferences", CHECKPOINT_MAX_MATERIAL_ENTRIES, source);
  const commandResults = boundedArray(checkpoint.commandResults, "commandResults", CHECKPOINT_MAX_MATERIAL_ENTRIES, execution);
  const testResults = boundedArray(checkpoint.testResults, "testResults", CHECKPOINT_MAX_MATERIAL_ENTRIES, execution);
  const materialClaims = boundedArray(checkpoint.materialClaims, "materialClaims", CHECKPOINT_MAX_MATERIAL_ENTRIES, claim);
  const materialTotal = filesTouched.length
    + artifactReferences.length
    + sourceReferences.length
    + commandResults.length
    + testResults.length
    + materialClaims.length;
  if (materialTotal > CHECKPOINT_MAX_MATERIAL_ENTRIES) invalid("checkpoint.materialEntries");
  return Object.freeze({
    taskSummary: parseBoundedString(checkpoint.taskSummary, "taskSummary", CHECKPOINT_MAX_TASK_SUMMARY_SCALARS),
    completedItems,
    inProgressItems,
    blockers,
    nextActions,
    decisions,
    assumptions,
    unresolvedConflicts,
    filesTouched,
    artifactReferences,
    sourceReferences,
    commandResults,
    testResults,
    materialClaims,
  });
}

function assertCheckpointBytes(value: CheckpointDraft | Checkpoint): void {
  if (Buffer.byteLength(canonicalJson(value), "utf8") > CHECKPOINT_MAX_CANONICAL_BYTES) {
    invalid("checkpoint.canonicalBytes");
  }
}

function evidenceCoverageV2(value: unknown): CheckpointEvidenceCoverageV2 {
  const coverage = exactRecord(
    value,
    ["coverageVersion", "captureMode", "contentRetained", "adapterSessions"],
    "evidenceCoverage",
  );
  if (
    coverage.coverageVersion !== 2
    || coverage.captureMode !== "coverage-only"
    || coverage.contentRetained !== false
  ) invalid("evidenceCoverage");
  const source = strictArray(coverage.adapterSessions, "evidenceCoverage.adapterSessions");
  if (source.length > 200) throw new LifecycleError("EVIDENCE_ADAPTER_SESSION_LIMIT");
  let previousAdapterSessionId: string | null = null;
  let totalIntervals = 0;
  const adapterSessions = source.map((item, index): CheckpointAdapterCoverageV2 => {
    const field = `evidenceCoverage.adapterSessions[${index}]`;
    const adapter = exactRecord(item, [
      "adapterSessionId",
      "coverageFirstOrdinal",
      "coverageLastOrdinal",
      "highestContiguousOrdinal",
      "missingIntervals",
      "frameFingerprintAlgorithm",
      "frameFingerprintSchemaVersion",
      "frameFingerprintKeyId",
      "frameFingerprintDomain",
      "coverageFingerprintAlgorithm",
      "coverageFingerprintSchemaVersion",
      "coverageFingerprintKeyId",
      "coverageFingerprintDomain",
      "coverageFingerprint",
      "latestBatchId",
      "latestBatchEventPosition",
    ], field);
    if (
      adapter.coverageFirstOrdinal !== "0"
      || adapter.frameFingerprintAlgorithm !== "hmac-sha256"
      || adapter.frameFingerprintSchemaVersion !== 1
      || adapter.frameFingerprintDomain !== "pm-evidence-frame-v1"
      || adapter.coverageFingerprintAlgorithm !== "hmac-sha256"
      || adapter.coverageFingerprintSchemaVersion !== 1
      || adapter.coverageFingerprintDomain !== "pm-evidence-coverage-v1"
    ) invalid(field);
    const adapterSessionId = parseLifecycleId<AdapterSessionId>(
      adapter.adapterSessionId,
      `${field}.adapterSessionId`,
    );
    if (
      previousAdapterSessionId !== null
      && Buffer.compare(Buffer.from(previousAdapterSessionId, "utf8"), Buffer.from(adapterSessionId, "utf8")) >= 0
    ) invalid("evidenceCoverage.adapterSessions");
    previousAdapterSessionId = adapterSessionId;
    const coverageLastOrdinal = parseDecimalString(
      adapter.coverageLastOrdinal,
      `${field}.coverageLastOrdinal`,
    );
    const highestContiguousOrdinal = adapter.highestContiguousOrdinal === null
      ? null
      : parseDecimalString(
          adapter.highestContiguousOrdinal,
          `${field}.highestContiguousOrdinal`,
        );
    if (
      highestContiguousOrdinal !== null
      && BigInt(highestContiguousOrdinal) > BigInt(coverageLastOrdinal)
    ) invalid(`${field}.highestContiguousOrdinal`);
    const intervalSource = strictArray(adapter.missingIntervals, `${field}.missingIntervals`);
    if (intervalSource.length > CHECKPOINT_MAX_MISSING_INTERVALS) {
      throw new LifecycleError("EVIDENCE_COVERAGE_TOO_FRAGMENTED");
    }
    totalIntervals += intervalSource.length;
    if (totalIntervals > CHECKPOINT_MAX_MISSING_INTERVALS) {
      throw new LifecycleError("EVIDENCE_COVERAGE_TOO_FRAGMENTED");
    }
    const missingIntervals = intervalSource.map((entry, intervalIndex) =>
      interval(entry, `${field}.missingIntervals[${intervalIndex}]`));
    for (let intervalIndex = 0; intervalIndex < missingIntervals.length; intervalIndex += 1) {
      const current = missingIntervals[intervalIndex];
      const previous = missingIntervals[intervalIndex - 1];
      if (
        current === undefined
        || BigInt(current.lastOrdinal) > BigInt(coverageLastOrdinal)
        || (
          previous !== undefined
          && BigInt(current.firstOrdinal) <= BigInt(previous.lastOrdinal) + 1n
        )
      ) invalid(`${field}.missingIntervals`);
    }
    const firstMissing = missingIntervals[0];
    if (
      firstMissing === undefined
        ? highestContiguousOrdinal !== coverageLastOrdinal
        : BigInt(firstMissing.firstOrdinal) !== (
            highestContiguousOrdinal === null ? 0n : BigInt(highestContiguousOrdinal) + 1n
          )
    ) invalid(`${field}.missingIntervals`);
    const frameFingerprintKeyId = parseBoundedString(
      adapter.frameFingerprintKeyId,
      `${field}.frameFingerprintKeyId`,
      128,
    );
    const coverageFingerprintKeyId = parseBoundedString(
      adapter.coverageFingerprintKeyId,
      `${field}.coverageFingerprintKeyId`,
      128,
    );
    if (coverageFingerprintKeyId !== frameFingerprintKeyId) invalid(`${field}.coverageFingerprintKeyId`);
    return Object.freeze({
      adapterSessionId,
      coverageFirstOrdinal: "0",
      coverageLastOrdinal,
      highestContiguousOrdinal,
      missingIntervals: Object.freeze(missingIntervals),
      frameFingerprintAlgorithm: "hmac-sha256",
      frameFingerprintSchemaVersion: 1,
      frameFingerprintKeyId,
      frameFingerprintDomain: "pm-evidence-frame-v1",
      coverageFingerprintAlgorithm: "hmac-sha256",
      coverageFingerprintSchemaVersion: 1,
      coverageFingerprintKeyId,
      coverageFingerprintDomain: "pm-evidence-coverage-v1",
      coverageFingerprint: hash(adapter.coverageFingerprint, `${field}.coverageFingerprint`) as string,
      latestBatchId: parseLifecycleId<EvidenceBatchId>(adapter.latestBatchId, `${field}.latestBatchId`),
      latestBatchEventPosition: parseDecimalString(
        adapter.latestBatchEventPosition,
        `${field}.latestBatchEventPosition`,
      ),
    });
  });
  const decoded = Object.freeze({
    coverageVersion: 2 as const,
    captureMode: "coverage-only" as const,
    contentRetained: false as const,
    adapterSessions: Object.freeze(adapterSessions),
  });
  if (Buffer.byteLength(canonicalJson(decoded), "utf8") > CHECKPOINT_EVIDENCE_COVERAGE_MAX_CANONICAL_BYTES) {
    throw new LifecycleError("EVIDENCE_COVERAGE_SNAPSHOT_TOO_LARGE");
  }
  return decoded;
}

export function decodeCheckpointDraftV1(value: unknown): CheckpointDraftV1 {
  const checkpoint = exactRecord(
    value,
    ["checkpointVersion", ...CHECKPOINT_CONTENT_KEYS],
    "checkpointDraft",
  );
  if (checkpoint.checkpointVersion !== 1) invalid("checkpointVersion");
  const decoded = Object.freeze({
    checkpointVersion: 1 as const,
    ...decodeCheckpointContent(checkpoint),
  });
  assertCheckpointBytes(decoded);
  return decoded;
}

export function decodeCheckpointV1(value: unknown): CheckpointV1 {
  const checkpoint = exactRecord(value, [
    "checkpointVersion",
    "checkpointId",
    "sessionId",
    "parentSessionId",
    "baseEventPosition",
    "checkpointEventPosition",
    "createdAt",
    "creatorAgentId",
    "creatorClientInstanceId",
    ...CHECKPOINT_CONTENT_KEYS,
    "sourceState",
    "childSummaries",
    "evidenceCoverage",
  ], "checkpoint");
  if (checkpoint.checkpointVersion !== 1) invalid("checkpointVersion");
  const baseEventPosition = parseDecimalString(checkpoint.baseEventPosition, "baseEventPosition");
  const checkpointEventPosition = parseDecimalString(
    checkpoint.checkpointEventPosition,
    "checkpointEventPosition",
  );
  if (BigInt(baseEventPosition) > BigInt(checkpointEventPosition)) {
    throw new LifecycleError("CHECKPOINT_BASE_INVALID");
  }

  const content = decodeCheckpointContent(checkpoint);

  const decoded: CheckpointV1 = Object.freeze({
    checkpointVersion: 1,
    checkpointId: parseLifecycleId<CheckpointId>(checkpoint.checkpointId, "checkpointId"),
    sessionId: parseLifecycleId<SessionId>(checkpoint.sessionId, "sessionId"),
    parentSessionId: parseNullableUuid<SessionId>(checkpoint.parentSessionId, "parentSessionId"),
    baseEventPosition,
    checkpointEventPosition,
    createdAt: parseCanonicalTimestamp(checkpoint.createdAt, "createdAt"),
    creatorAgentId: parseBoundedString(checkpoint.creatorAgentId, "creatorAgentId", 256),
    creatorClientInstanceId: parseBoundedString(
      checkpoint.creatorClientInstanceId,
      "creatorClientInstanceId",
      256,
    ),
    ...content,
    sourceState: sourceState(checkpoint.sourceState),
    childSummaries: Object.freeze(strictArray(checkpoint.childSummaries, "childSummaries").map(
      (child, index) => childSummary(child, `childSummaries[${index}]`),
    )),
    evidenceCoverage: evidenceCoverage(checkpoint.evidenceCoverage),
  });

  assertCheckpointBytes(decoded);
  return decoded;
}

export function decodeCheckpointDraftV2(value: unknown): CheckpointDraftV2 {
  const checkpoint = exactRecord(
    value,
    ["checkpointVersion", ...CHECKPOINT_CONTENT_KEYS],
    "checkpointDraft",
  );
  if (checkpoint.checkpointVersion !== 2) invalid("checkpointVersion");
  const decoded = Object.freeze({
    checkpointVersion: 2 as const,
    ...decodeCheckpointContent(checkpoint),
  });
  assertCheckpointBytes(decoded);
  return decoded;
}

export function decodeCheckpointV2(value: unknown): CheckpointV2 {
  const checkpoint = exactRecord(value, [
    "checkpointVersion",
    "checkpointId",
    "sessionId",
    "parentSessionId",
    "baseEventPosition",
    "checkpointEventPosition",
    "createdAt",
    "creatorAgentId",
    "creatorClientInstanceId",
    ...CHECKPOINT_CONTENT_KEYS,
    "sourceState",
    "childSummaries",
    "evidenceCoverage",
  ], "checkpoint");
  if (checkpoint.checkpointVersion !== 2) invalid("checkpointVersion");
  const baseEventPosition = parseDecimalString(checkpoint.baseEventPosition, "baseEventPosition");
  const checkpointEventPosition = parseDecimalString(
    checkpoint.checkpointEventPosition,
    "checkpointEventPosition",
  );
  if (BigInt(baseEventPosition) > BigInt(checkpointEventPosition)) {
    throw new LifecycleError("CHECKPOINT_BASE_INVALID");
  }
  const decodedCoverage = evidenceCoverageV2(checkpoint.evidenceCoverage);
  if (decodedCoverage.adapterSessions.some(
    (adapter) => BigInt(adapter.latestBatchEventPosition) > BigInt(baseEventPosition),
  )) invalid("evidenceCoverage.adapterSessions.latestBatchEventPosition");
  const childSummaries = strictArray(checkpoint.childSummaries, "childSummaries").map(
    (child, index) => childSummary(child, `childSummaries[${index}]`),
  );
  for (let index = 1; index < childSummaries.length; index += 1) {
    const previous = childSummaries[index - 1];
    const current = childSummaries[index];
    if (
      previous === undefined
      || current === undefined
      || Buffer.compare(
        Buffer.from(previous.childSessionId, "utf8"),
        Buffer.from(current.childSessionId, "utf8"),
      ) >= 0
    ) invalid("childSummaries");
  }
  if (decodedCoverage.adapterSessions.some((adapter) => adapter.latestBatchEventPosition === "0")) {
    invalid("evidenceCoverage.adapterSessions.latestBatchEventPosition");
  }
  const decoded: CheckpointV2 = Object.freeze({
    checkpointVersion: 2,
    checkpointId: parseLifecycleId<CheckpointId>(checkpoint.checkpointId, "checkpointId"),
    sessionId: parseLifecycleId<SessionId>(checkpoint.sessionId, "sessionId"),
    parentSessionId: parseNullableUuid<SessionId>(checkpoint.parentSessionId, "parentSessionId"),
    baseEventPosition,
    checkpointEventPosition,
    createdAt: parseCanonicalTimestamp(checkpoint.createdAt, "createdAt"),
    creatorAgentId: parseBoundedString(checkpoint.creatorAgentId, "creatorAgentId", 256),
    creatorClientInstanceId: parseBoundedString(
      checkpoint.creatorClientInstanceId,
      "creatorClientInstanceId",
      256,
    ),
    ...decodeCheckpointContent(checkpoint),
    sourceState: sourceState(checkpoint.sourceState),
    childSummaries: Object.freeze(childSummaries),
    evidenceCoverage: decodedCoverage,
  });
  if (Buffer.byteLength(canonicalJson(decoded), "utf8") > CHECKPOINT_MAX_CANONICAL_BYTES) {
    throw new LifecycleError("CHECKPOINT_CAPACITY_EXCEEDED");
  }
  return decoded;
}

export function decodeCheckpointDraft(value: unknown): CheckpointDraft {
  const version = strictRecord(value, "checkpointDraft").checkpointVersion;
  if (version === 1) return decodeCheckpointDraftV1(value);
  if (version === 2) return decodeCheckpointDraftV2(value);
  return invalid("checkpointVersion");
}

export function decodeCheckpoint(value: unknown): Checkpoint {
  const version = strictRecord(value, "checkpoint").checkpointVersion;
  if (version === 1) return decodeCheckpointV1(value);
  if (version === 2) return decodeCheckpointV2(value);
  return invalid("checkpointVersion");
}
