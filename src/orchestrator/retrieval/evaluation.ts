import { createHash } from "node:crypto";

import type {
  BranchScopeId,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../identity/contracts.js";
import type { ProjectBinding } from "../projections/contracts.js";
import type {
  InternalRetrievalRequest,
  InternalRetrievalResultItem,
  RetrievalVisibility,
} from "./contracts.js";
import type {
  InternalRetrievalService,
  RankedInternalRetrievalResult,
} from "./service.js";

const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const SECRET_BEARING_TEXT = /raw[-_ ]?evidence|authorization|credential|bearer\s|private[-_ ]?key/i;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const MAX_PLAIN_DATA_DEPTH = 64;
const MAX_PLAIN_DATA_STRING_BYTES = 1_048_576;

export const RETRIEVAL_EVALUATION_CRITICAL_CLASSES = Object.freeze([
  "identifiers",
  "code-artifacts",
  "session-continuity",
  "follow-ups",
  "stale-superseded-facts",
  "conflicts",
  "cross-project-near-duplicates",
  "semantic-paraphrases",
  "temporal-boundaries",
] as const);

export type RetrievalEvaluationCriticalClass =
  typeof RETRIEVAL_EVALUATION_CRITICAL_CLASSES[number];
export type RetrievalEvaluationLanguage = "en" | "th" | "mixed";
export type RetrievalEvaluationRelevanceGrade = 0 | 1 | 2 | 3;
export type RetrievalEvaluationCorpusVersion =
  | "retrieval-evaluation-v1"
  | "retrieval-evaluation-v2";

export interface RetrievalEvaluationEligibleScopeV1 {
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly branchScopeId: string | null;
  readonly branchRef: string | null;
  readonly sessionId: string | null;
  readonly visibility: RetrievalVisibility;
  readonly validAt: string | null;
  readonly knownAt: string | null;
  readonly requiredEventPosition: string;
  readonly deadlineMs: number;
}

export interface RetrievalEvaluationCitationV1 {
  readonly itemId: string;
  readonly anchor: string | null;
}

export interface RetrievalEvaluationJudgmentV1 {
  readonly judgeId: string;
  readonly relevanceGrades: Readonly<Record<string, RetrievalEvaluationRelevanceGrade>>;
}

export interface RetrievalEvaluationExpectationsV1 {
  readonly exactIdentifierPath: boolean;
  readonly currentSessionCheckpoint: boolean;
  readonly openFollowUp: boolean;
  readonly nextAction: boolean;
  readonly semanticParaphrase: boolean;
  readonly bitemporal: boolean;
  readonly conflictGroupIds: readonly string[];
}

export interface RetrievalEvaluationQueryV1 {
  readonly queryId: string;
  readonly language: RetrievalEvaluationLanguage;
  readonly criticalClass: RetrievalEvaluationCriticalClass;
  readonly queryText: string;
  readonly eligibleScope: RetrievalEvaluationEligibleScopeV1;
  readonly expectedCitations: readonly RetrievalEvaluationCitationV1[];
  readonly judgments: readonly [
    RetrievalEvaluationJudgmentV1,
    RetrievalEvaluationJudgmentV1,
  ];
  readonly relevanceGrades: Readonly<Record<string, RetrievalEvaluationRelevanceGrade>>;
  readonly expectations: RetrievalEvaluationExpectationsV1;
}

export interface RetrievalEvaluationCorpusV1 {
  readonly schemaVersion: 1;
  readonly corpusVersion: "retrieval-evaluation-v1";
  readonly fixtureSeed: "awakened-ai-retrieval-evaluation-v1-fixed-seed";
  readonly evidencePolicy: "synthetic-identifiers-only";
  readonly queries: readonly RetrievalEvaluationQueryV1[];
}

export interface RetrievalEvaluationReport {
  readonly corpusVersion: RetrievalEvaluationCorpusVersion;
  readonly queryCount: number;
  readonly failedQueryCount: number;
  readonly languageCounts: Readonly<Record<RetrievalEvaluationLanguage, number>>;
  readonly criticalClassCounts: Readonly<Record<RetrievalEvaluationCriticalClass, number>>;
  readonly crossProjectContamination: number;
  readonly recallAt10: number;
  readonly mrr: number;
  readonly ndcgAt10: number;
  readonly citationPrecision: number;
  readonly citationRecall: number;
  readonly staleActiveMemoryRate: number;
  readonly exactIdentifierPathRecall: number;
  readonly currentSessionCheckpointRecallAt10: number;
  readonly openFollowUpRecallAt10: number;
  readonly nextActionRecallAt10: number;
  readonly semanticParaphraseRecallAt10: number;
  readonly bitemporalAccuracy: number;
  readonly conflictRecall: number;
  readonly conflictPrecision: number;
  readonly unsupportedHighImpactVerifiedClaims: number;
}

export interface RetrievalEvaluationBundleV2 {
  readonly schemaVersion: 2;
  readonly corpusVersion: "retrieval-evaluation-v2";
  readonly files: Readonly<Record<
    "source-events.json" | "judgments.json" | "v1-shadow-baseline.json",
    string
  >>;
}

export interface FrozenV1ShadowBaseline {
  readonly schemaVersion: 1;
  readonly v1Version: string;
  readonly judgmentsSha256: string;
  readonly metrics: RetrievalEvaluationReport;
  readonly provenanceCommand: string;
}

export interface SealedRetrievalEvaluationSourceV2 {
  readonly binding: ProjectBinding;
  readonly events: readonly Readonly<Record<string, unknown>>[];
}

export interface RetrievalEvaluationSourceEventsV2 {
  readonly schemaVersion: 2;
  readonly corpusVersion: "retrieval-evaluation-v2";
  readonly sources: readonly SealedRetrievalEvaluationSourceV2[];
}

export interface RetrievalEvaluationJudgmentsV2 {
  readonly schemaVersion: 2;
  readonly corpusVersion: "retrieval-evaluation-v2";
  readonly queries: readonly RetrievalEvaluationQueryV1[];
}

export interface SealedRetrievalEvaluationCorpusV2 {
  readonly bundle: RetrievalEvaluationBundleV2;
  readonly sources: readonly SealedRetrievalEvaluationSourceV2[];
  readonly queries: readonly RetrievalEvaluationQueryV1[];
  readonly baseline: FrozenV1ShadowBaseline;
}

export type RetrievalEvaluationService = Pick<InternalRetrievalService, "retrieve">;

export class RetrievalEvaluationCorpusError extends TypeError {
  constructor() {
    super("RETRIEVAL_EVALUATION_CORPUS_INVALID");
    this.name = "RetrievalEvaluationCorpusError";
  }
}

function invalid(): never {
  throw new RetrievalEvaluationCorpusError();
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    || keys.some((key) => !ownKeys.includes(key))
  ) return invalid();
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return invalid();
    output[key] = descriptor.value;
  }
  return output;
}

function arrayItems(
  value: unknown,
  minimumLength: number,
  maximumLength = Number.MAX_SAFE_INTEGER,
): readonly unknown[] {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimumLength
    || value.length > maximumLength
  ) return invalid();
  const expectedKeys = [
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    "length",
  ];
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length
    || ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) return invalid();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || lengthDescriptor.enumerable
    || lengthDescriptor.value !== value.length
  ) return invalid();
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return invalid();
    }
    output.push(descriptor.value);
  }
  return Object.freeze(output);
}

function safeText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || value.normalize("NFKC") !== value
    || CONTROL.test(value)
    || SECRET_BEARING_TEXT.test(value)
  ) return invalid();
  return value;
}

function safePropertyName(value: string): string {
  if (
    value.length === 0
    || Buffer.byteLength(value, "utf8") > 512
    || value.normalize("NFKC") !== value
    || CONTROL.test(value)
  ) return invalid();
  return value;
}

function clonePlainData(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (depth > MAX_PLAIN_DATA_DEPTH) return invalid();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return safeText(value, MAX_PLAIN_DATA_STRING_BYTES);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) return invalid();
    return value;
  }
  if (typeof value !== "object") return invalid();
  if (seen.has(value)) return invalid();
  seen.add(value);
  if (Array.isArray(value)) {
    const entries = arrayItems(value, 0);
    return Object.freeze(entries.map((entry) => clonePlainData(entry, seen, depth + 1)));
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return invalid();
  const output: Record<string, unknown> = {};
  for (const key of ownKeys as string[]) {
    safePropertyName(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return invalid();
    }
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: clonePlainData(descriptor.value, seen, depth + 1),
      writable: true,
    });
  }
  return Object.freeze(output);
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> {
  const output = clonePlainData(value);
  if (typeof output !== "object" || output === null || Array.isArray(output)) return invalid();
  return output as Readonly<Record<string, unknown>>;
}

function canonicalSha256(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") return invalid();
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function nullableText(value: unknown, maximumBytes: number): string | null {
  if (value === null) return null;
  return safeText(value, maximumBytes);
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) return invalid();
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) return invalid();
  return value;
}

function nullableUuid(value: unknown): string | null {
  if (value === null) return null;
  return uuid(value);
}

function canonicalTimestamp(value: unknown): string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > 24
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) return invalid();
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null) return null;
  return canonicalTimestamp(value);
}

function decimal(value: unknown): string {
  if (typeof value !== "string" || !UNSIGNED_DECIMAL.test(value)) return invalid();
  const parsed = BigInt(value);
  if (parsed > SQLITE_INT64_MAX) return invalid();
  return value;
}

function nullableDecimal(value: unknown): string | null {
  if (value === null) return null;
  return decimal(value);
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid();
  return value;
}

function relevanceGrades(
  value: unknown,
): Readonly<Record<string, RetrievalEvaluationRelevanceGrade>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length === 0
    || keys.length > 50
    || keys.some((key) => typeof key !== "string")
  ) return invalid();
  const output: Record<string, RetrievalEvaluationRelevanceGrade> = {};
  for (const itemId of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, itemId);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return invalid();
    const grade = descriptor.value as unknown;
    uuid(itemId);
    if (!Number.isInteger(grade) || Number(grade) < 0 || Number(grade) > 3) return invalid();
    output[itemId] = Number(grade) as RetrievalEvaluationRelevanceGrade;
  }
  if (!Object.values(output).some((grade) => grade > 0)) return invalid();
  return Object.freeze(output);
}

function eligibleScope(value: unknown): RetrievalEvaluationEligibleScopeV1 {
  const source = exactRecord(value, [
    "projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef",
    "sessionId", "visibility", "validAt", "knownAt", "requiredEventPosition", "deadlineMs",
  ]);
  const visibility = source.visibility;
  if (!(visibility === "project" || visibility === "workspace" || visibility === "branch" || visibility === "session")) {
    return invalid();
  }
  const sessionId = nullableUuid(source.sessionId);
  if ((visibility === "session") !== (sessionId !== null)) return invalid();
  if (!Number.isSafeInteger(source.deadlineMs) || Number(source.deadlineMs) < 1 || Number(source.deadlineMs) > 30_000) {
    return invalid();
  }
  return Object.freeze({
    projectId: hash(source.projectId),
    vaultId: hash(source.vaultId),
    storeId: hash(source.storeId),
    workspaceId: hash(source.workspaceId),
    branchScopeId: nullableUuid(source.branchScopeId),
    branchRef: nullableText(source.branchRef, 1_024),
    sessionId,
    visibility,
    validAt: nullableTimestamp(source.validAt),
    knownAt: nullableDecimal(source.knownAt),
    requiredEventPosition: decimal(source.requiredEventPosition),
    deadlineMs: Number(source.deadlineMs),
  });
}

function citations(value: unknown): readonly RetrievalEvaluationCitationV1[] {
  const entries = arrayItems(value, 1, 50);
  const seen = new Set<string>();
  return Object.freeze(entries.map((entry) => {
    const source = exactRecord(entry, ["itemId", "anchor"]);
    const citation = Object.freeze({
      itemId: uuid(source.itemId),
      anchor: nullableText(source.anchor, 2_048),
    });
    const key = `${citation.itemId}\u0000${citation.anchor ?? ""}`;
    if (seen.has(key)) return invalid();
    seen.add(key);
    return citation;
  }));
}

function judgment(value: unknown): RetrievalEvaluationJudgmentV1 {
  const source = exactRecord(value, ["judgeId", "relevanceGrades"]);
  const judgeId = safeText(source.judgeId, 64);
  if (!SAFE_ID.test(judgeId)) return invalid();
  return Object.freeze({
    judgeId,
    relevanceGrades: relevanceGrades(source.relevanceGrades),
  });
}

function expectations(value: unknown): RetrievalEvaluationExpectationsV1 {
  const source = exactRecord(value, [
    "exactIdentifierPath", "currentSessionCheckpoint", "openFollowUp", "nextAction",
    "semanticParaphrase", "bitemporal", "conflictGroupIds",
  ]);
  const conflictGroupEntries = arrayItems(source.conflictGroupIds, 0, 20);
  const conflictGroupIds = conflictGroupEntries.map((entry) => {
    const id = safeText(entry, 128);
    if (!SAFE_ID.test(id)) return invalid();
    return id;
  });
  if (new Set(conflictGroupIds).size !== conflictGroupIds.length) return invalid();
  return Object.freeze({
    exactIdentifierPath: boolean(source.exactIdentifierPath),
    currentSessionCheckpoint: boolean(source.currentSessionCheckpoint),
    openFollowUp: boolean(source.openFollowUp),
    nextAction: boolean(source.nextAction),
    semanticParaphrase: boolean(source.semanticParaphrase),
    bitemporal: boolean(source.bitemporal),
    conflictGroupIds: Object.freeze(conflictGroupIds),
  });
}

function evaluationQuery(
  value: unknown,
  ordinal: number,
  expectedPrefix: "eval-v1-" | "eval-v2-",
): RetrievalEvaluationQueryV1 {
  const source = exactRecord(value, [
    "queryId", "language", "criticalClass", "queryText", "eligibleScope",
    "expectedCitations", "judgments", "relevanceGrades", "expectations",
  ]);
  const queryId = safeText(source.queryId, 32);
  if (queryId !== `${expectedPrefix}${String(ordinal).padStart(4, "0")}`) return invalid();
  const language = source.language;
  if (!(language === "en" || language === "th" || language === "mixed")) return invalid();
  const criticalClass = source.criticalClass;
  if (!RETRIEVAL_EVALUATION_CRITICAL_CLASSES.includes(
    criticalClass as RetrievalEvaluationCriticalClass,
  )) return invalid();
  const judgmentEntries = arrayItems(source.judgments, 2, 2);
  const parsedJudgments = judgmentEntries.map(judgment) as unknown as [
    RetrievalEvaluationJudgmentV1,
    RetrievalEvaluationJudgmentV1,
  ];
  if (parsedJudgments[0].judgeId === parsedJudgments[1].judgeId) return invalid();
  const grades = relevanceGrades(source.relevanceGrades);
  const parsedCitations = citations(source.expectedCitations);
  if (parsedCitations.some((citation) => (grades[citation.itemId] ?? 0) === 0)) return invalid();
  const parsedScope = eligibleScope(source.eligibleScope);
  const parsedExpectations = expectations(source.expectations);
  if (
    (criticalClass === "session-continuity") !== parsedExpectations.currentSessionCheckpoint
    || (criticalClass === "semantic-paraphrases") !== parsedExpectations.semanticParaphrase
    || (criticalClass === "temporal-boundaries") !== parsedExpectations.bitemporal
    || ((criticalClass === "identifiers" || criticalClass === "code-artifacts")
      !== parsedExpectations.exactIdentifierPath)
    || ((criticalClass === "conflicts") !== (parsedExpectations.conflictGroupIds.length > 0))
    || (criticalClass === "follow-ups"
      && !parsedExpectations.openFollowUp
      && !parsedExpectations.nextAction)
  ) return invalid();
  return Object.freeze({
    queryId,
    language,
    criticalClass: criticalClass as RetrievalEvaluationCriticalClass,
    queryText: safeText(source.queryText, 4_096),
    eligibleScope: parsedScope,
    expectedCitations: parsedCitations,
    judgments: Object.freeze(parsedJudgments),
    relevanceGrades: grades,
    expectations: parsedExpectations,
  });
}

export function parseRetrievalEvaluationCorpus(value: unknown): RetrievalEvaluationCorpusV1 {
  const source = exactRecord(value, [
    "schemaVersion", "corpusVersion", "fixtureSeed", "evidencePolicy", "queries",
  ]);
  if (
    source.schemaVersion !== 1
    || source.corpusVersion !== "retrieval-evaluation-v1"
    || source.fixtureSeed !== "awakened-ai-retrieval-evaluation-v1-fixed-seed"
    || source.evidencePolicy !== "synthetic-identifiers-only"
  ) return invalid();
  const queryEntries = arrayItems(source.queries, 500, 500);
  const queries = Object.freeze(queryEntries.map((query, index) => (
    evaluationQuery(query, index + 1, "eval-v1-")
  )));
  if (new Set(queries.map((query) => query.queryId)).size !== queries.length) return invalid();
  if (new Set(queries.map((query) => query.queryText)).size !== queries.length) return invalid();
  for (const criticalClass of RETRIEVAL_EVALUATION_CRITICAL_CLASSES) {
    if (queries.filter((query) => query.criticalClass === criticalClass).length < 50) return invalid();
  }
  for (const language of ["en", "th", "mixed"] as const) {
    if (queries.filter((query) => query.language === language).length < 50) return invalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    corpusVersion: "retrieval-evaluation-v1",
    fixtureSeed: "awakened-ai-retrieval-evaluation-v1-fixed-seed",
    evidencePolicy: "synthetic-identifiers-only",
    queries,
  });
}

function parseBundleManifest(value: unknown): RetrievalEvaluationBundleV2 {
  const source = exactRecord(value, ["schemaVersion", "corpusVersion", "files"]);
  if (
    source.schemaVersion !== 2
    || source.corpusVersion !== "retrieval-evaluation-v2"
  ) return invalid();
  const fileSource = exactRecord(source.files, [
    "source-events.json",
    "judgments.json",
    "v1-shadow-baseline.json",
  ]);
  const files = Object.freeze({
    "source-events.json": hash(fileSource["source-events.json"]),
    "judgments.json": hash(fileSource["judgments.json"]),
    "v1-shadow-baseline.json": hash(fileSource["v1-shadow-baseline.json"]),
  });
  return Object.freeze({
    schemaVersion: 2,
    corpusVersion: "retrieval-evaluation-v2",
    files,
  });
}

function parseProjectBinding(value: unknown): ProjectBinding {
  const source = exactRecord(value, [
    "projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId",
  ]);
  return Object.freeze({
    projectId: hash(source.projectId) as ProjectId,
    vaultId: hash(source.vaultId) as VaultId,
    storeId: hash(source.storeId) as StoreId,
    workspaceId: hash(source.workspaceId) as WorkspaceId,
    branchScopeId: nullableUuid(source.branchScopeId) as BranchScopeId | null,
    branchRef: nullableText(source.branchRef, 1_024),
    sessionId: nullableUuid(source.sessionId),
  });
}

function parseSourceEventsV2(value: unknown): RetrievalEvaluationSourceEventsV2 {
  const source = exactRecord(value, ["schemaVersion", "corpusVersion", "sources"]);
  if (
    source.schemaVersion !== 2
    || source.corpusVersion !== "retrieval-evaluation-v2"
  ) return invalid();
  const sourceEntries = arrayItems(source.sources, 1);
  const seenBindings = new Set<string>();
  const seenEventIds = new Set<string>();
  const seenIdempotencyKeys = new Set<string>();
  const sources = sourceEntries.map((entry): SealedRetrievalEvaluationSourceV2 => {
    const sourceRecord = exactRecord(entry, ["binding", "events"]);
    const binding = parseProjectBinding(sourceRecord.binding);
    const bindingKey = JSON.stringify(binding);
    if (seenBindings.has(bindingKey)) return invalid();
    seenBindings.add(bindingKey);
    const eventEntries = arrayItems(sourceRecord.events, 1);
    const events = eventEntries.map((eventValue) => {
      const event = plainRecord(eventValue);
      const eventId = uuid(event.eventId);
      const idempotencyKey = safeText(event.idempotencyKey, 256);
      if (seenEventIds.has(eventId) || seenIdempotencyKeys.has(idempotencyKey)) return invalid();
      seenEventIds.add(eventId);
      seenIdempotencyKeys.add(idempotencyKey);
      if (event.globalPosition !== undefined) decimal(event.globalPosition);
      if (event.streamVersion !== undefined) decimal(event.streamVersion);
      for (const hashField of ["payloadHash", "previousGlobalHash", "eventHash"] as const) {
        if (event[hashField] !== undefined) hash(event[hashField]);
      }
      return event;
    });
    return Object.freeze({ binding, events: Object.freeze(events) });
  });
  return Object.freeze({
    schemaVersion: 2,
    corpusVersion: "retrieval-evaluation-v2",
    sources: Object.freeze(sources),
  });
}

function parseJudgmentsV2(value: unknown): RetrievalEvaluationJudgmentsV2 {
  const source = exactRecord(value, ["schemaVersion", "corpusVersion", "queries"]);
  if (
    source.schemaVersion !== 2
    || source.corpusVersion !== "retrieval-evaluation-v2"
  ) return invalid();
  const queryEntries = arrayItems(source.queries, 1);
  const queries = Object.freeze(queryEntries.map((query, index) => (
    evaluationQuery(query, index + 1, "eval-v2-")
  )));
  if (new Set(queries.map((query) => query.queryId)).size !== queries.length) return invalid();
  if (new Set(queries.map((query) => query.queryText)).size !== queries.length) return invalid();
  return Object.freeze({
    schemaVersion: 2,
    corpusVersion: "retrieval-evaluation-v2",
    queries,
  });
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || Number(value) < 0) return invalid();
  return Number(value);
}

function unitInterval(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || Object.is(value, -0)
    || value < 0
    || value > 1
  ) return invalid();
  return value;
}

function parseFrozenReport(
  value: unknown,
  queries: readonly RetrievalEvaluationQueryV1[],
): RetrievalEvaluationReport {
  const source = exactRecord(value, [
    "corpusVersion", "queryCount", "failedQueryCount", "languageCounts",
    "criticalClassCounts", "crossProjectContamination", "recallAt10", "mrr",
    "ndcgAt10", "citationPrecision", "citationRecall", "staleActiveMemoryRate",
    "exactIdentifierPathRecall", "currentSessionCheckpointRecallAt10",
    "openFollowUpRecallAt10", "nextActionRecallAt10", "semanticParaphraseRecallAt10",
    "bitemporalAccuracy", "conflictRecall", "conflictPrecision",
    "unsupportedHighImpactVerifiedClaims",
  ]);
  if (source.corpusVersion !== "retrieval-evaluation-v1") return invalid();
  const queryCount = nonnegativeInteger(source.queryCount);
  const failedQueryCount = nonnegativeInteger(source.failedQueryCount);
  if (queryCount !== queries.length || failedQueryCount > queryCount) return invalid();

  const languageSource = exactRecord(source.languageCounts, ["en", "th", "mixed"]);
  const languageCounts = Object.freeze({
    en: nonnegativeInteger(languageSource.en),
    th: nonnegativeInteger(languageSource.th),
    mixed: nonnegativeInteger(languageSource.mixed),
  });
  for (const language of ["en", "th", "mixed"] as const) {
    if (languageCounts[language] !== queries.filter((query) => query.language === language).length) {
      return invalid();
    }
  }

  const classSource = exactRecord(
    source.criticalClassCounts,
    RETRIEVAL_EVALUATION_CRITICAL_CLASSES,
  );
  const criticalClassCounts = Object.freeze(Object.fromEntries(
    RETRIEVAL_EVALUATION_CRITICAL_CLASSES.map((criticalClass) => [
      criticalClass,
      nonnegativeInteger(classSource[criticalClass]),
    ]),
  )) as Readonly<Record<RetrievalEvaluationCriticalClass, number>>;
  for (const criticalClass of RETRIEVAL_EVALUATION_CRITICAL_CLASSES) {
    if (
      criticalClassCounts[criticalClass]
      !== queries.filter((query) => query.criticalClass === criticalClass).length
    ) return invalid();
  }

  return Object.freeze({
    corpusVersion: "retrieval-evaluation-v1",
    queryCount,
    failedQueryCount,
    languageCounts,
    criticalClassCounts,
    crossProjectContamination: nonnegativeInteger(source.crossProjectContamination),
    recallAt10: unitInterval(source.recallAt10),
    mrr: unitInterval(source.mrr),
    ndcgAt10: unitInterval(source.ndcgAt10),
    citationPrecision: unitInterval(source.citationPrecision),
    citationRecall: unitInterval(source.citationRecall),
    staleActiveMemoryRate: unitInterval(source.staleActiveMemoryRate),
    exactIdentifierPathRecall: unitInterval(source.exactIdentifierPathRecall),
    currentSessionCheckpointRecallAt10: unitInterval(source.currentSessionCheckpointRecallAt10),
    openFollowUpRecallAt10: unitInterval(source.openFollowUpRecallAt10),
    nextActionRecallAt10: unitInterval(source.nextActionRecallAt10),
    semanticParaphraseRecallAt10: unitInterval(source.semanticParaphraseRecallAt10),
    bitemporalAccuracy: unitInterval(source.bitemporalAccuracy),
    conflictRecall: unitInterval(source.conflictRecall),
    conflictPrecision: unitInterval(source.conflictPrecision),
    unsupportedHighImpactVerifiedClaims: nonnegativeInteger(
      source.unsupportedHighImpactVerifiedClaims,
    ),
  });
}

function parseFrozenV1ShadowBaseline(
  value: unknown,
  queries: readonly RetrievalEvaluationQueryV1[],
): FrozenV1ShadowBaseline {
  const source = exactRecord(value, [
    "schemaVersion", "v1Version", "judgmentsSha256", "metrics", "provenanceCommand",
  ]);
  if (source.schemaVersion !== 1) return invalid();
  const judgmentsSha256 = hash(source.judgmentsSha256);
  if (judgmentsSha256 !== canonicalSha256(queries)) return invalid();
  return Object.freeze({
    schemaVersion: 1,
    v1Version: safeText(source.v1Version, 256),
    judgmentsSha256,
    metrics: parseFrozenReport(source.metrics, queries),
    provenanceCommand: safeText(source.provenanceCommand, 2_048),
  });
}

export function parseSealedRetrievalEvaluationBundle(
  manifest: unknown,
  sourceEvents: unknown,
  judgments: unknown,
  baseline: unknown,
): SealedRetrievalEvaluationCorpusV2 {
  try {
    const bundle = parseBundleManifest(manifest);
    const sourceArtifact = parseSourceEventsV2(sourceEvents);
    const judgmentsArtifact = parseJudgmentsV2(judgments);
    const parsedBaseline = parseFrozenV1ShadowBaseline(baseline, judgmentsArtifact.queries);
    if (
      bundle.files["source-events.json"] !== canonicalSha256(sourceArtifact)
      || bundle.files["judgments.json"] !== canonicalSha256(judgmentsArtifact)
      || bundle.files["v1-shadow-baseline.json"] !== canonicalSha256(parsedBaseline)
    ) return invalid();
    return Object.freeze({
      bundle,
      sources: sourceArtifact.sources,
      queries: judgmentsArtifact.queries,
      baseline: parsedBaseline,
    });
  } catch (error) {
    if (error instanceof RetrievalEvaluationCorpusError) throw error;
    return invalid();
  }
}

interface RetrievalEvaluationOutcome {
  readonly query: RetrievalEvaluationQueryV1;
  readonly failed: boolean;
  readonly recallAt10: number;
  readonly reciprocalRank: number;
  readonly ndcgAt10: number;
  readonly citationTruePositives: number;
  readonly returnedCitationCount: number;
  readonly expectedCitationCount: number;
  readonly staleActiveCount: number;
  readonly returnedItemCount: number;
  readonly crossProjectContamination: number;
  readonly bitemporalCorrect: number;
  readonly expectedConflictCount: number;
  readonly returnedConflictCount: number;
  readonly conflictTruePositives: number;
  readonly unsupportedHighImpactVerifiedClaims: number;
}

function requestFor(query: RetrievalEvaluationQueryV1): InternalRetrievalRequest {
  const scope = query.eligibleScope;
  const binding: ProjectBinding = Object.freeze({
    projectId: scope.projectId as ProjectId,
    vaultId: scope.vaultId as VaultId,
    storeId: scope.storeId as StoreId,
    workspaceId: scope.workspaceId as WorkspaceId,
    branchScopeId: scope.branchScopeId as BranchScopeId | null,
    branchRef: scope.branchRef,
    sessionId: null,
  });
  const vector = Object.freeze({ enabled: false } as const);
  assertSealedEvaluationVectorDisabled(vector);
  return Object.freeze({
    binding,
    query: query.queryText,
    limit: 10,
    tokenBudget: 32_768,
    consistency: Object.freeze({
      requiredEventPosition: BigInt(scope.requiredEventPosition),
      deadlineMs: scope.deadlineMs,
    }),
    candidateLimit: 512,
    explain: false,
    includeGlobal: false,
    visibility: scope.visibility,
    vector,
    ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }),
    ...(scope.validAt === null ? {} : { validAt: scope.validAt }),
    ...(scope.knownAt === null ? {} : { knownAt: BigInt(scope.knownAt) }),
  });
}

/** Sealed V2 evaluation never permits vector retrieval into its measured result. */
export function assertSealedEvaluationVectorDisabled(
  vector: Readonly<{ readonly enabled: boolean }> | undefined,
): asserts vector is Readonly<{ readonly enabled: false }> {
  if (vector?.enabled !== false) invalid();
}

function relevantIds(query: RetrievalEvaluationQueryV1): readonly string[] {
  return Object.freeze(Object.entries(query.relevanceGrades)
    .filter(([, grade]) => grade > 0)
    .map(([itemId]) => itemId));
}

function discountedGain(grades: readonly number[]): number {
  return grades.reduce((total, grade, index) => (
    total + ((2 ** grade) - 1) / Math.log2(index + 2)
  ), 0);
}

function resultCitationKey(item: InternalRetrievalResultItem): string {
  return `${item.id}\u0000${item.anchor ?? ""}`;
}

function expectedCitationKey(citation: RetrievalEvaluationCitationV1): string {
  return `${citation.itemId}\u0000${citation.anchor ?? ""}`;
}

function staleOrInactive(item: InternalRetrievalResultItem): boolean {
  return item.freshness !== "fresh"
    || item.status === "superseded"
    || item.status === "retracted"
    || item.status === "expired"
    || item.status === "erased-evidence";
}

function outcomeFor(
  query: RetrievalEvaluationQueryV1,
  result: RankedInternalRetrievalResult | null,
): RetrievalEvaluationOutcome {
  const returnedItems = result?.items ?? [];
  const seenItemIds = new Set<string>();
  const items = returnedItems.slice(0, 10).filter((item) => {
    if (seenItemIds.has(item.id)) return false;
    seenItemIds.add(item.id);
    return true;
  });
  const relevant = new Set(relevantIds(query));
  const retrievedRelevant = items.filter((item) => relevant.has(item.id));
  const firstRelevant = items.findIndex((item) => relevant.has(item.id));
  const gains = items.map((item) => query.relevanceGrades[item.id] ?? 0);
  const idealGains = Object.values(query.relevanceGrades)
    .filter((grade) => grade > 0)
    .sort((left, right) => right - left)
    .slice(0, 10);
  const idealDcg = discountedGain(idealGains);
  const expectedCitations = new Set(query.expectedCitations.map(expectedCitationKey));
  const returnedCitations = items.map(resultCitationKey);
  const expectedConflicts = new Set(query.expectations.conflictGroupIds);
  const returnedConflicts = new Set(result?.conflicts.map((conflict) => conflict.conflictGroupId) ?? []);
  const unsupportedHighImpactVerifiedClaims = items.filter((item) => (
    item.status === "verified"
    && item.confidence === "high"
    && item.conflictGroupId !== null
    && (query.relevanceGrades[item.id] ?? 0) === 0
  )).length;
  return Object.freeze({
    query,
    failed: result === null,
    recallAt10: retrievedRelevant.length / relevant.size,
    reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    ndcgAt10: idealDcg === 0 ? 0 : discountedGain(gains) / idealDcg,
    citationTruePositives: returnedCitations.filter((key) => expectedCitations.has(key)).length,
    returnedCitationCount: returnedCitations.length,
    expectedCitationCount: expectedCitations.size,
    staleActiveCount: items.filter(staleOrInactive).length,
    returnedItemCount: items.length,
    crossProjectContamination: returnedItems.filter((item) => (
      item.projectId !== query.eligibleScope.projectId
    )).length,
    bitemporalCorrect: query.expectations.bitemporal
      ? Number(items.length > 0 && relevant.has(items[0]!.id))
      : 0,
    expectedConflictCount: expectedConflicts.size,
    returnedConflictCount: returnedConflicts.size,
    conflictTruePositives: [...returnedConflicts].filter((id) => expectedConflicts.has(id)).length,
    unsupportedHighImpactVerifiedClaims,
  });
}

async function evaluateOne(
  query: RetrievalEvaluationQueryV1,
  service: RetrievalEvaluationService,
): Promise<RetrievalEvaluationOutcome> {
  try {
    return outcomeFor(query, await service.retrieve(requestFor(query)));
  } catch {
    return outcomeFor(query, null);
  }
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function sum(outcomes: readonly RetrievalEvaluationOutcome[], select: (outcome: RetrievalEvaluationOutcome) => number): number {
  return outcomes.reduce((total, outcome) => total + select(outcome), 0);
}

function subgroupRecall(
  outcomes: readonly RetrievalEvaluationOutcome[],
  select: (query: RetrievalEvaluationQueryV1) => boolean,
): number {
  return mean(outcomes.filter((outcome) => select(outcome.query)).map((outcome) => outcome.recallAt10));
}

export async function evaluateRetrievalQueries(
  queries: readonly RetrievalEvaluationQueryV1[],
  corpusVersion: RetrievalEvaluationCorpusVersion,
  service: RetrievalEvaluationService,
): Promise<RetrievalEvaluationReport> {
  if (
    corpusVersion !== "retrieval-evaluation-v1"
    && corpusVersion !== "retrieval-evaluation-v2"
  ) return invalid();
  const outcomes: RetrievalEvaluationOutcome[] = [];
  for (const query of queries) outcomes.push(await evaluateOne(query, service));
  const returnedCitationCount = sum(outcomes, (outcome) => outcome.returnedCitationCount);
  const expectedCitationCount = sum(outcomes, (outcome) => outcome.expectedCitationCount);
  const returnedItemCount = sum(outcomes, (outcome) => outcome.returnedItemCount);
  const returnedConflictCount = sum(outcomes, (outcome) => outcome.returnedConflictCount);
  const expectedConflictCount = sum(outcomes, (outcome) => outcome.expectedConflictCount);
  const bitemporal = outcomes.filter((outcome) => outcome.query.expectations.bitemporal);
  const languageCounts = Object.freeze({
    en: queries.filter((query) => query.language === "en").length,
    th: queries.filter((query) => query.language === "th").length,
    mixed: queries.filter((query) => query.language === "mixed").length,
  });
  const criticalClassCounts = Object.freeze(Object.fromEntries(
    RETRIEVAL_EVALUATION_CRITICAL_CLASSES.map((criticalClass) => [
      criticalClass,
      queries.filter((query) => query.criticalClass === criticalClass).length,
    ]),
  )) as Readonly<Record<RetrievalEvaluationCriticalClass, number>>;
  return Object.freeze({
    corpusVersion,
    queryCount: outcomes.length,
    failedQueryCount: outcomes.filter((outcome) => outcome.failed).length,
    languageCounts,
    criticalClassCounts,
    crossProjectContamination: sum(outcomes, (outcome) => outcome.crossProjectContamination),
    recallAt10: mean(outcomes.map((outcome) => outcome.recallAt10)),
    mrr: mean(outcomes.map((outcome) => outcome.reciprocalRank)),
    ndcgAt10: mean(outcomes.map((outcome) => outcome.ndcgAt10)),
    citationPrecision: returnedCitationCount === 0
      ? 0
      : sum(outcomes, (outcome) => outcome.citationTruePositives) / returnedCitationCount,
    citationRecall: expectedCitationCount === 0
      ? 0
      : sum(outcomes, (outcome) => outcome.citationTruePositives) / expectedCitationCount,
    staleActiveMemoryRate: returnedItemCount === 0
      ? 0
      : sum(outcomes, (outcome) => outcome.staleActiveCount) / returnedItemCount,
    exactIdentifierPathRecall: subgroupRecall(outcomes, (query) => query.expectations.exactIdentifierPath),
    currentSessionCheckpointRecallAt10: subgroupRecall(
      outcomes,
      (query) => query.expectations.currentSessionCheckpoint,
    ),
    openFollowUpRecallAt10: subgroupRecall(outcomes, (query) => query.expectations.openFollowUp),
    nextActionRecallAt10: subgroupRecall(outcomes, (query) => query.expectations.nextAction),
    semanticParaphraseRecallAt10: subgroupRecall(
      outcomes,
      (query) => query.expectations.semanticParaphrase,
    ),
    bitemporalAccuracy: bitemporal.length === 0
      ? 0
      : sum(bitemporal, (outcome) => outcome.bitemporalCorrect) / bitemporal.length,
    conflictRecall: expectedConflictCount === 0
      ? 0
      : sum(outcomes, (outcome) => outcome.conflictTruePositives) / expectedConflictCount,
    conflictPrecision: returnedConflictCount === 0
      ? 0
      : sum(outcomes, (outcome) => outcome.conflictTruePositives) / returnedConflictCount,
    unsupportedHighImpactVerifiedClaims: sum(
      outcomes,
      (outcome) => outcome.unsupportedHighImpactVerifiedClaims,
    ),
  });
}

export async function evaluateRetrieval(
  corpus: RetrievalEvaluationCorpusV1,
  service: RetrievalEvaluationService,
): Promise<RetrievalEvaluationReport> {
  const validated = parseRetrievalEvaluationCorpus(corpus);
  return evaluateRetrievalQueries(validated.queries, "retrieval-evaluation-v1", service);
}

/** Pure sealed aggregate gate shared by the evaluator and its valid-report tests. */
export function assertSealedRetrievalThresholds(
  report: RetrievalEvaluationReport,
  baseline: RetrievalEvaluationReport,
): void {
  if (
    report.failedQueryCount !== 0
    || report.crossProjectContamination !== 0
    || report.recallAt10 < 0.95
    || report.mrr < 0.90
    || report.ndcgAt10 < 0.90
    || report.citationPrecision < 0.95
    || report.citationRecall < 0.95
    || report.staleActiveMemoryRate > 0.01
    || report.exactIdentifierPathRecall !== 1
    || report.currentSessionCheckpointRecallAt10 !== 1
    || report.openFollowUpRecallAt10 !== 1
    || report.nextActionRecallAt10 !== 1
    || report.semanticParaphraseRecallAt10 < 0.90
    || report.bitemporalAccuracy < 0.95
    || report.conflictRecall !== 1
    || report.conflictPrecision !== 1
    || report.unsupportedHighImpactVerifiedClaims !== 0
  ) return invalid();
  for (const metric of [
    "recallAt10", "mrr", "ndcgAt10", "citationPrecision", "citationRecall",
    "exactIdentifierPathRecall", "currentSessionCheckpointRecallAt10",
    "openFollowUpRecallAt10", "nextActionRecallAt10", "semanticParaphraseRecallAt10",
    "bitemporalAccuracy", "conflictRecall", "conflictPrecision",
  ] as const) {
    if (report[metric] < baseline[metric]) return invalid();
  }
  if (
    report.staleActiveMemoryRate > baseline.staleActiveMemoryRate
    || report.unsupportedHighImpactVerifiedClaims > baseline.unsupportedHighImpactVerifiedClaims
  ) return invalid();
}

export async function evaluateSealedRetrieval(
  corpus: SealedRetrievalEvaluationCorpusV2,
  service: RetrievalEvaluationService,
): Promise<RetrievalEvaluationReport> {
  const report = await evaluateRetrievalQueries(
    corpus.queries,
    "retrieval-evaluation-v2",
    service,
  );
  assertSealedRetrievalThresholds(report, corpus.baseline.metrics);
  return report;
}
