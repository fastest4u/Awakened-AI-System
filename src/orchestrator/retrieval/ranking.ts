import { createHash } from "node:crypto";

import {
  InternalRetrievalError,
  type InternalRetrievalRequest,
  type RetrievalChannel,
  type RetrievalChannelResult,
  type RetrievalItem,
  type ValidatedInternalRetrievalRequest,
} from "./contracts.js";

const CHANNELS = Object.freeze([
  "exact",
  "alias",
  "lexical",
  "symbol-path",
  "session-checkpoint",
  "open-follow-up",
  "conflict-closure",
] as const satisfies readonly RetrievalChannel[]);

export const RANKING_UNIT_SCALE = 10_000 as const;

export const RERANK_FEATURE_NAMES = Object.freeze([
  "verificationState",
  "provenanceQuality",
  "temporalValidity",
  "queryIntent",
  "scopeDistance",
  "conflictState",
  "sourceFreshness",
  "retrievalFeedback",
] as const);

export type RerankFeatureName = typeof RERANK_FEATURE_NAMES[number];

export interface RankingPolicy {
  readonly version: string;
  readonly rrfK: number;
  readonly channelWeightUnits: Readonly<Record<RetrievalChannel, number>>;
  readonly temporalDecay: Readonly<{
    readonly eventHalfLife: number;
    readonly floorUnits: number;
  }>;
  readonly rerankFeatureNames: readonly RerankFeatureName[];
  readonly rerankWeightUnits: Readonly<Record<RerankFeatureName, number>>;
  readonly diversity: Readonly<{
    readonly maxPerSource: number;
    readonly maxPerEntity: number;
  }>;
}

/**
 * Task 6's shadow-only release policy. Values remain immutable until the
 * bilingual evaluation task records a successor policy version.
 */
export const DEFAULT_RANKING_POLICY: RankingPolicy = Object.freeze({
  version: "retrieval-ranking-v2-shadow-fixed-units",
  rrfK: 60,
  channelWeightUnits: Object.freeze({
    exact: 25_000,
    alias: 17_500,
    lexical: 10_000,
    "symbol-path": 20_000,
    "session-checkpoint": 18_000,
    "open-follow-up": 18_000,
    "conflict-closure": 0,
  }),
  temporalDecay: Object.freeze({
    eventHalfLife: 10_000,
    floorUnits: 2_500,
  }),
  rerankFeatureNames: RERANK_FEATURE_NAMES,
  rerankWeightUnits: Object.freeze({
    verificationState: 120,
    provenanceQuality: 60,
    temporalValidity: 40,
    queryIntent: 120,
    scopeDistance: 40,
    conflictState: 40,
    sourceFreshness: 40,
    retrievalFeedback: 20,
  }),
  diversity: Object.freeze({
    maxPerSource: 2,
    maxPerEntity: 2,
  }),
});

export interface RankingCandidate {
  readonly id: string;
  readonly rank: number;
  readonly channel: RetrievalChannel;
  readonly item?: RetrievalItem;
  readonly conflictGroupId?: string | null;
  readonly highImpact?: boolean;
  readonly sourceKey?: string | null;
  readonly entityKey?: string | null;
  readonly estimatedTokens?: number;
  readonly feedbackScoreUnits?: number;
  readonly conflictTotalMemberCount?: number;
  readonly conflictCursor?: string | null;
}

export interface RationalScore {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export interface FusionContribution {
  readonly channel: RetrievalChannel;
  readonly rank: number;
  readonly weightUnits: number;
  readonly score: RationalScore;
}

export interface FusedCandidate {
  readonly id: string;
  readonly item?: RetrievalItem;
  readonly conflictGroupId: string | null;
  readonly highImpact: boolean;
  readonly sourceKey: string | null;
  readonly entityKey: string | null;
  readonly estimatedTokens: number | null;
  readonly feedbackScoreUnits: number;
  readonly conflictTotalMemberCount: number | null;
  readonly conflictCursor: string | null;
  readonly contributions: readonly FusionContribution[];
  readonly fusionScore: RationalScore;
  readonly bestRank: number;
}

export interface RerankedCandidate extends FusedCandidate {
  readonly features: Readonly<Record<RerankFeatureName, number>>;
  readonly featureScore: RationalScore;
  readonly rerankScore: RationalScore;
}

export interface RetrievalRanker {
  select(
    eligible: readonly FusedCandidate[],
    request: ValidatedInternalRetrievalRequest,
  ): readonly FusedCandidate[];
}

export interface RankedConflictGroup {
  readonly conflictGroupId: string;
  readonly totalMemberCount: number;
  readonly selectedMemberCount: number;
  readonly highImpact: boolean;
  readonly truncated: boolean;
  readonly cursor: string | null;
}

export interface RankedSelection {
  readonly candidates: readonly FusedCandidate[];
  readonly conflicts: readonly RankedConflictGroup[];
  readonly usedTokens: number;
  readonly truncated: boolean;
  readonly droppedByReason: Readonly<{
    readonly diversity: number;
    readonly resultLimit: number;
    readonly tokenBudget: number;
    readonly conflictSuppressed: number;
  }>;
}

type CandidateChannel = readonly RankingCandidate[] | RetrievalChannelResult;

const CHANNEL_INDEX = new Map<RetrievalChannel, number>(
  CHANNELS.map((channel, index) => [channel, index]),
);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(name);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(name);
  return value;
}

function boundedKey(value: string | null | undefined, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new TypeError(name);
  }
  return value;
}

function assertExactRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(name);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  const ownKeys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null)
    || ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) throw new TypeError(name);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(name);
    }
  }
}

function assertPolicy(policy: RankingPolicy): void {
  assertExactRecord(policy, [
    "version",
    "rrfK",
    "channelWeightUnits",
    "temporalDecay",
    "rerankFeatureNames",
    "rerankWeightUnits",
    "diversity",
  ], "ranking policy");
  assertExactRecord(policy.channelWeightUnits, CHANNELS, "ranking policy channel weights");
  assertExactRecord(
    policy.temporalDecay,
    ["eventHalfLife", "floorUnits"],
    "ranking policy temporal decay",
  );
  assertExactRecord(
    policy.rerankWeightUnits,
    RERANK_FEATURE_NAMES,
    "ranking policy rerank weights",
  );
  assertExactRecord(
    policy.diversity,
    ["maxPerSource", "maxPerEntity"],
    "ranking policy diversity",
  );
  if (
    typeof policy.version !== "string"
    || policy.version.length === 0
    || Buffer.byteLength(policy.version, "utf8") > 128
  ) throw new TypeError("ranking policy version");
  positiveInteger(policy.rrfK, "ranking policy rrfK");
  for (const channel of CHANNELS) {
    nonnegativeInteger(policy.channelWeightUnits[channel], `ranking weight ${channel}`);
  }
  positiveInteger(policy.temporalDecay.eventHalfLife, "temporal event half-life");
  const floor = nonnegativeInteger(policy.temporalDecay.floorUnits, "temporal floor");
  if (floor > RANKING_UNIT_SCALE) throw new TypeError("temporal floor");
  if (
    policy.rerankFeatureNames.length !== RERANK_FEATURE_NAMES.length
    || policy.rerankFeatureNames.some((name, index) => name !== RERANK_FEATURE_NAMES[index])
  ) throw new TypeError("rerank feature set");
  for (const name of RERANK_FEATURE_NAMES) {
    nonnegativeInteger(policy.rerankWeightUnits[name], `rerank weight ${name}`);
  }
  positiveInteger(policy.diversity.maxPerSource, "source diversity");
  positiveInteger(policy.diversity.maxPerEntity, "entity diversity");
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = absolute(left);
  let b = absolute(right);
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

function rational(numerator: bigint, denominator: bigint): RationalScore {
  if (denominator <= 0n) throw new TypeError("rational score denominator");
  if (numerator === 0n) return Object.freeze({ numerator: 0n, denominator: 1n });
  const divisor = greatestCommonDivisor(numerator, denominator);
  return Object.freeze({
    numerator: numerator / divisor,
    denominator: denominator / divisor,
  });
}

export function addRationalScores(left: RationalScore, right: RationalScore): RationalScore {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

export function compareRationalScores(left: RationalScore, right: RationalScore): number {
  const comparison = left.numerator * right.denominator - right.numerator * left.denominator;
  return comparison < 0n ? -1 : comparison > 0n ? 1 : 0;
}

export function formatRationalScore(score: RationalScore): string {
  return `${score.numerator}/${score.denominator}`;
}

const ZERO_SCORE = rational(0n, 1n);

export function weightedRrf(rank: number, weightUnits: number, k = 60): RationalScore {
  positiveInteger(rank, "RRF rank");
  nonnegativeInteger(weightUnits, "RRF weight units");
  positiveInteger(k, "RRF k");
  return rational(
    BigInt(weightUnits),
    BigInt(RANKING_UNIT_SCALE) * BigInt(k + rank),
  );
}

function fromChannelResult(result: RetrievalChannelResult): readonly RankingCandidate[] {
  return result.candidates.map((candidate) => Object.freeze({
    id: `${candidate.item.kind}:${candidate.item.id}`,
    rank: candidate.rank,
    channel: candidate.channel,
    item: candidate.item,
    conflictGroupId: candidate.item.conflictGroupId,
    feedbackScoreUnits: candidate.item.retrievalFeedbackScoreUnits,
  }));
}

function channelCandidates(channel: CandidateChannel): readonly RankingCandidate[] {
  return Array.isArray(channel)
    ? channel as readonly RankingCandidate[]
    : fromChannelResult(channel as RetrievalChannelResult);
}

function candidateSignature(candidate: RankingCandidate): string {
  return [
    candidate.channel,
    candidate.rank.toString(),
    candidate.item?.projectId ?? "",
    candidate.item?.workspaceId ?? "",
    candidate.item?.branchScopeId ?? "",
    candidate.item?.branchRef ?? "",
    candidate.item?.sessionId ?? "",
    candidate.item?.kind ?? "",
    candidate.item?.id ?? "",
    candidate.item?.sourceEventPosition.toString() ?? "",
    candidate.conflictGroupId ?? "",
    candidate.sourceKey ?? "",
    candidate.entityKey ?? "",
    candidate.estimatedTokens?.toString() ?? "",
    candidate.feedbackScoreUnits?.toString() ?? "",
    candidate.conflictTotalMemberCount?.toString() ?? "",
    candidate.conflictCursor ?? "",
  ].join("\u0000");
}

function compareCandidateSource(left: RankingCandidate, right: RankingCandidate): number {
  const channel = (CHANNEL_INDEX.get(left.channel) ?? Number.MAX_SAFE_INTEGER)
    - (CHANNEL_INDEX.get(right.channel) ?? Number.MAX_SAFE_INTEGER);
  if (channel !== 0) return channel;
  if (left.rank !== right.rank) return left.rank - right.rank;
  return compareText(candidateSignature(left), candidateSignature(right));
}

function smallestKey(
  candidates: readonly RankingCandidate[],
  select: (candidate: RankingCandidate) => string | null | undefined,
  name: string,
): string | null {
  const values = candidates
    .map((candidate) => boundedKey(select(candidate), name))
    .filter((value): value is string => value !== null)
    .sort(compareText);
  return values[0] ?? null;
}

function validateCandidate(candidate: RankingCandidate): void {
  boundedKey(candidate.id, "ranking candidate id");
  positiveInteger(candidate.rank, "ranking candidate rank");
  if (!CHANNEL_INDEX.has(candidate.channel)) throw new TypeError("ranking candidate channel");
  if (candidate.estimatedTokens !== undefined) {
    positiveInteger(candidate.estimatedTokens, "estimated candidate tokens");
  }
  if (candidate.feedbackScoreUnits !== undefined) {
    const score = candidate.feedbackScoreUnits;
    if (!Number.isSafeInteger(score) || score < -RANKING_UNIT_SCALE || score > RANKING_UNIT_SCALE) {
      throw new TypeError("retrieval feedback score");
    }
  }
  if (candidate.conflictTotalMemberCount !== undefined) {
    positiveInteger(candidate.conflictTotalMemberCount, "conflict total member count");
  }
  boundedKey(candidate.conflictGroupId, "conflict group id");
  boundedKey(candidate.conflictCursor, "conflict cursor");
  boundedKey(candidate.sourceKey, "source diversity key");
  boundedKey(candidate.entityKey, "entity diversity key");
}

export function fuseCandidates(
  channels: readonly CandidateChannel[],
  policy: RankingPolicy = DEFAULT_RANKING_POLICY,
): readonly FusedCandidate[] {
  assertPolicy(policy);
  const byId = new Map<string, Map<RetrievalChannel, RankingCandidate>>();
  for (const channel of channels) {
    for (const candidate of channelCandidates(channel)) {
      validateCandidate(candidate);
      const contributions = byId.get(candidate.id) ?? new Map<RetrievalChannel, RankingCandidate>();
      const current = contributions.get(candidate.channel);
      if (
        current === undefined
        || candidate.rank < current.rank
        || (
          candidate.rank === current.rank
          && compareCandidateSource(candidate, current) < 0
        )
      ) contributions.set(candidate.channel, candidate);
      byId.set(candidate.id, contributions);
    }
  }

  const fused: FusedCandidate[] = [];
  for (const [id, contributionMap] of byId) {
    const sources = [...contributionMap.values()].sort(compareCandidateSource);
    const representative = sources.find((candidate) => candidate.item !== undefined) ?? sources[0];
    if (representative === undefined) continue;
    const contributions = sources.map((candidate): FusionContribution => {
      const weightUnits = policy.channelWeightUnits[candidate.channel];
      return Object.freeze({
        channel: candidate.channel,
        rank: candidate.rank,
        weightUnits,
        score: weightedRrf(candidate.rank, weightUnits, policy.rrfK),
      });
    });
    const estimated = sources
      .map((candidate) => candidate.estimatedTokens)
      .filter((value): value is number => value !== undefined);
    const feedback = sources
      .map((candidate) => candidate.feedbackScoreUnits)
      .filter((value): value is number => value !== undefined)
      .sort((left, right) => right - left)[0] ?? 0;
    const conflictTotals = sources
      .map((candidate) => candidate.conflictTotalMemberCount)
      .filter((value): value is number => value !== undefined);
    const output: FusedCandidate = {
      id,
      ...(representative.item === undefined ? {} : { item: representative.item }),
      conflictGroupId: smallestKey(
        sources,
        (candidate) => candidate.conflictGroupId,
        "conflict group id",
      ),
      highImpact: sources.some((candidate) => candidate.highImpact === true),
      sourceKey: smallestKey(sources, (candidate) => candidate.sourceKey, "source diversity key"),
      entityKey: smallestKey(sources, (candidate) => candidate.entityKey, "entity diversity key"),
      estimatedTokens: estimated.length === 0 ? null : Math.max(...estimated),
      feedbackScoreUnits: feedback,
      conflictTotalMemberCount: conflictTotals.length === 0 ? null : Math.max(...conflictTotals),
      conflictCursor: smallestKey(sources, (candidate) => candidate.conflictCursor, "conflict cursor"),
      contributions: Object.freeze(contributions),
      fusionScore: contributions.reduce(
        (total, contribution) => addRationalScores(total, contribution.score),
        ZERO_SCORE,
      ),
      bestRank: Math.min(...contributions.map((contribution) => contribution.rank)),
    };
    fused.push(Object.freeze(output));
  }
  fused.sort((left, right) => (
    compareRationalScores(right.fusionScore, left.fusionScore)
    || left.bestRank - right.bestRank
    || compareText(left.id, right.id)
  ));
  return Object.freeze(fused);
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function verificationFeature(item: RetrievalItem | undefined): number {
  if (item === undefined) return 0;
  const status = {
    verified: 10_000,
    active: 9_000,
    open: 9_000,
    blocked: 8_000,
    conflicted: 8_000,
    provisional: 4_500,
    candidate: 2_500,
    superseded: 1_500,
    retracted: 0,
    expired: 0,
    "erased-evidence": 0,
  }[item.status];
  const confidence = { high: 10_000, medium: 7_500, low: 4_000, guess: 1_000 }[item.confidence];
  return Math.trunc((status + confidence) / 2);
}

function provenanceFeature(item: RetrievalItem | undefined): number {
  if (item === undefined) return 0;
  if (
    item.verificationMethod === "committed-event"
    || item.verificationMethod === "session-checkpoint"
    || item.verificationMethod === "checkpoint-artifact"
    || item.verificationMethod === "open-follow-up"
  ) return 10_000;
  if (item.verificationMethod === "projection-chunk") return 6_500;
  return 3_500;
}

function temporalFeature(
  item: RetrievalItem | undefined,
  request: InternalRetrievalRequest,
  policy: RankingPolicy,
): number {
  if (item === undefined) return 0;
  const reference = request.knownAt ?? request.consistency.requiredEventPosition;
  if (item.sourceEventPosition > reference) return 0;
  const distance = reference - item.sourceEventPosition;
  const halfLife = BigInt(policy.temporalDecay.eventHalfLife);
  const decayed = Number(
    (BigInt(RANKING_UNIT_SCALE) * halfLife) / (halfLife + distance),
  );
  return Math.max(policy.temporalDecay.floorUnits, decayed);
}

function queryFeature(item: RetrievalItem | undefined, query: string): number {
  if (item === undefined) return 0;
  const needle = normalized(query);
  const exact = [item.id, item.normalizedKey, item.anchor]
    .filter((value): value is string => value !== null)
    .map(normalized);
  if (exact.includes(needle)) return 10_000;
  if (
    needle.length >= 3
    && exact.some((value) => value.length >= 3
      && (value.includes(needle) || needle.includes(value)))
  ) return 5_000;
  return 0;
}

function scopeFeature(item: RetrievalItem | undefined, request: InternalRetrievalRequest): number {
  if (item === undefined) return 0;
  const level = { project: 0, workspace: 1, branch: 2, session: 3 } as const;
  const requested = request.visibility
    ?? (request.sessionId === undefined ? "branch" : "session");
  const distance = Math.abs(level[requested] - level[item.visibility]);
  return Math.max(0, RANKING_UNIT_SCALE - Math.trunc(distance * RANKING_UNIT_SCALE / 3));
}

function conflictFeature(candidate: FusedCandidate): number {
  if (candidate.conflictGroupId !== null || candidate.item?.status === "conflicted") return 10_000;
  if (candidate.item?.status === "superseded") return 2_500;
  return 0;
}

function features(
  candidate: FusedCandidate,
  request: InternalRetrievalRequest,
  policy: RankingPolicy,
): Readonly<Record<RerankFeatureName, number>> {
  return Object.freeze({
    verificationState: verificationFeature(candidate.item),
    provenanceQuality: provenanceFeature(candidate.item),
    temporalValidity: temporalFeature(candidate.item, request, policy),
    queryIntent: queryFeature(candidate.item, request.query),
    scopeDistance: scopeFeature(candidate.item, request),
    conflictState: conflictFeature(candidate),
    sourceFreshness: candidate.item?.freshness === "fresh" ? 10_000 : 0,
    retrievalFeedback: Math.trunc((candidate.feedbackScoreUnits + RANKING_UNIT_SCALE) / 2),
  });
}

export function rerankCandidates(
  candidates: readonly FusedCandidate[],
  request: InternalRetrievalRequest,
  policy: RankingPolicy = DEFAULT_RANKING_POLICY,
): readonly RerankedCandidate[] {
  assertPolicy(policy);
  const seen = new Set<string>();
  const reranked = candidates.map((candidate): RerankedCandidate => {
    if (seen.has(candidate.id)) throw new TypeError("duplicate fused candidate id");
    seen.add(candidate.id);
    const values = features(candidate, request, policy);
    const featureScore = RERANK_FEATURE_NAMES.reduce(
      (total, name) => addRationalScores(total, rational(
        BigInt(values[name]) * BigInt(policy.rerankWeightUnits[name]),
        BigInt(RANKING_UNIT_SCALE) * BigInt(RANKING_UNIT_SCALE),
      )),
      ZERO_SCORE,
    );
    return Object.freeze({
      ...candidate,
      features: values,
      featureScore,
      rerankScore: addRationalScores(candidate.fusionScore, featureScore),
    });
  });
  reranked.sort((left, right) => (
    compareRationalScores(right.rerankScore, left.rerankScore)
    || left.bestRank - right.bestRank
    || compareText(left.id, right.id)
  ));
  return Object.freeze(reranked);
}

export function validateCustomRanking(
  ranked: readonly FusedCandidate[],
  eligible: readonly FusedCandidate[],
): readonly FusedCandidate[] {
  const snapshot = [...ranked];
  if (snapshot.length !== eligible.length) {
    throw new InternalRetrievalError("RETRIEVAL_RANKER_INVALID");
  }
  const expected = new Set(eligible);
  for (const candidate of snapshot) {
    if (!expected.delete(candidate)) {
      throw new InternalRetrievalError("RETRIEVAL_RANKER_INVALID");
    }
  }
  if (expected.size !== 0) {
    throw new InternalRetrievalError("RETRIEVAL_RANKER_INVALID");
  }
  return Object.freeze(snapshot);
}

export function estimateCandidateTokens(candidate: Pick<FusedCandidate, "id" | "item">): number {
  const item = candidate.item;
  const value = item === undefined
    ? candidate.id
    : `${item.id}\n${item.normalizedKey}\n${item.summary}\n${item.anchor ?? ""}`;
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4));
}

function increment(counts: Map<string, number>, key: string | null): void {
  if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
}

function conflictCursor(
  policy: RankingPolicy,
  conflictGroupId: string,
  selectedMemberCount: number,
): string {
  const digest = createHash("sha256")
    .update(policy.version)
    .update("\u0000")
    .update(conflictGroupId)
    .update("\u0000")
    .update(selectedMemberCount.toString())
    .digest("hex")
    .slice(0, 32);
  return `retrieval-conflict-v1:${selectedMemberCount}:${digest}`;
}

export function selectRankedCandidates(
  candidates: readonly FusedCandidate[],
  bounds: Readonly<{ readonly limit: number; readonly tokenBudget: number }>,
  policy: RankingPolicy = DEFAULT_RANKING_POLICY,
): RankedSelection {
  assertPolicy(policy);
  positiveInteger(bounds.limit, "retrieval result limit");
  positiveInteger(bounds.tokenBudget, "retrieval token budget");
  const ordered = [...candidates];
  const seen = new Set<string>();
  for (const candidate of ordered) {
    if (seen.has(candidate.id)) throw new TypeError("duplicate reranked candidate id");
    seen.add(candidate.id);
  }

  const groups = new Map<string, FusedCandidate[]>();
  for (const candidate of ordered) {
    if (candidate.conflictGroupId === null) continue;
    const group = groups.get(candidate.conflictGroupId) ?? [];
    group.push(candidate);
    groups.set(candidate.conflictGroupId, group);
  }

  const selected: FusedCandidate[] = [];
  const selectedIds = new Set<string>();
  const processedGroups = new Set<string>();
  const sourceCounts = new Map<string, number>();
  const entityCounts = new Map<string, number>();
  let usedTokens = 0;
  let haltedForHighImpactConflict = false;
  const droppedIds = new Set<string>();
  const dropped = { diversity: 0, resultLimit: 0, tokenBudget: 0, conflictSuppressed: 0 };

  const admit = (candidate: FusedCandidate, bypassDiversity: boolean): "selected" | "limit" | "budget" | "diversity" => {
    if (selected.length >= bounds.limit) {
      dropped.resultLimit += 1;
      droppedIds.add(candidate.id);
      return "limit";
    }
    const tokens = candidate.estimatedTokens ?? estimateCandidateTokens(candidate);
    if (usedTokens + tokens > bounds.tokenBudget) {
      dropped.tokenBudget += 1;
      droppedIds.add(candidate.id);
      return "budget";
    }
    if (!bypassDiversity && (
      (candidate.sourceKey !== null
        && (sourceCounts.get(candidate.sourceKey) ?? 0) >= policy.diversity.maxPerSource)
      || (candidate.entityKey !== null
        && (entityCounts.get(candidate.entityKey) ?? 0) >= policy.diversity.maxPerEntity)
    )) {
      dropped.diversity += 1;
      droppedIds.add(candidate.id);
      return "diversity";
    }
    selected.push(candidate);
    selectedIds.add(candidate.id);
    usedTokens += tokens;
    increment(sourceCounts, candidate.sourceKey);
    increment(entityCounts, candidate.entityKey);
    return "selected";
  };

  for (const candidate of ordered) {
    if (selectedIds.has(candidate.id)) continue;
    const groupId = candidate.conflictGroupId;
    if (groupId === null) {
      admit(candidate, false);
      continue;
    }
    if (processedGroups.has(groupId)) continue;
    processedGroups.add(groupId);
    const members = groups.get(groupId) ?? [];
    let groupTruncated = false;
    for (const member of members) {
      const outcome = admit(member, true);
      if (outcome !== "selected") groupTruncated = true;
    }
    if (groupTruncated && members.some((member) => member.highImpact)) {
      haltedForHighImpactConflict = true;
      break;
    }
  }

  if (haltedForHighImpactConflict) {
    for (const candidate of ordered) {
      if (selectedIds.has(candidate.id) || droppedIds.has(candidate.id)) continue;
      dropped.conflictSuppressed += 1;
      droppedIds.add(candidate.id);
    }
  }

  const conflicts: RankedConflictGroup[] = [];
  for (const [conflictGroupId, members] of groups) {
    const selectedMemberCount = members.filter((member) => selectedIds.has(member.id)).length;
    const declaredMemberCount = members
      .map((member) => member.conflictTotalMemberCount)
      .filter((count): count is number => count !== null)
      .reduce((maximum, count) => Math.max(maximum, count), 0);
    const totalMemberCount = Math.max(members.length, declaredMemberCount);
    const truncated = selectedMemberCount < totalMemberCount;
    const repositoryCursor = members
      .map((member) => member.conflictCursor)
      .filter((cursor): cursor is string => cursor !== null)
      .sort(compareText)[0] ?? null;
    conflicts.push(Object.freeze({
      conflictGroupId,
      totalMemberCount,
      selectedMemberCount,
      highImpact: members.some((member) => member.highImpact),
      truncated,
      cursor: truncated
        ? repositoryCursor ?? conflictCursor(policy, conflictGroupId, selectedMemberCount)
        : null,
    }));
  }

  return Object.freeze({
    candidates: Object.freeze(selected),
    conflicts: Object.freeze(conflicts),
    usedTokens,
    truncated: haltedForHighImpactConflict || selected.length < ordered.length,
    droppedByReason: Object.freeze(dropped),
  });
}
