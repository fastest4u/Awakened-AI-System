import { createHash } from "node:crypto";

import type {
  InternalRetrievalRequest,
  RetrievalChannel,
  RetrievalChannelResult,
  RetrievalItem,
} from "./contracts.js";

const CHANNELS = Object.freeze([
  "exact",
  "alias",
  "lexical",
  "symbol-path",
  "session-checkpoint",
  "open-follow-up",
] as const satisfies readonly RetrievalChannel[]);

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
  readonly channelWeights: Readonly<Record<RetrievalChannel, number>>;
  readonly temporalDecay: Readonly<{
    readonly eventHalfLife: number;
    readonly floor: number;
  }>;
  readonly rerankFeatureNames: readonly RerankFeatureName[];
  readonly rerankWeights: Readonly<Record<RerankFeatureName, number>>;
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
  version: "retrieval-ranking-v1-shadow",
  rrfK: 60,
  channelWeights: Object.freeze({
    exact: 2.5,
    alias: 1.75,
    lexical: 1,
    "symbol-path": 2,
    "session-checkpoint": 1.8,
    "open-follow-up": 1.8,
  }),
  temporalDecay: Object.freeze({
    eventHalfLife: 10_000,
    floor: 0.25,
  }),
  rerankFeatureNames: RERANK_FEATURE_NAMES,
  rerankWeights: Object.freeze({
    verificationState: 0.012,
    provenanceQuality: 0.006,
    temporalValidity: 0.004,
    queryIntent: 0.012,
    scopeDistance: 0.004,
    conflictState: 0.004,
    sourceFreshness: 0.004,
    retrievalFeedback: 0.002,
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
  readonly feedbackScore?: number;
}

export interface FusionContribution {
  readonly channel: RetrievalChannel;
  readonly rank: number;
  readonly weight: number;
  readonly score: number;
}

export interface FusedCandidate {
  readonly id: string;
  readonly item?: RetrievalItem;
  readonly conflictGroupId: string | null;
  readonly highImpact: boolean;
  readonly sourceKey: string | null;
  readonly entityKey: string | null;
  readonly estimatedTokens: number | null;
  readonly feedbackScore: number;
  readonly contributions: readonly FusionContribution[];
  readonly fusionScore: number;
  readonly bestRank: number;
}

export interface RerankedCandidate extends FusedCandidate {
  readonly features: Readonly<Record<RerankFeatureName, number>>;
  readonly featureScore: number;
  readonly rerankScore: number;
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
  readonly candidates: readonly RerankedCandidate[];
  readonly conflicts: readonly RankedConflictGroup[];
  readonly usedTokens: number;
  readonly truncated: boolean;
  readonly droppedByReason: Readonly<{
    readonly diversity: number;
    readonly resultLimit: number;
    readonly tokenBudget: number;
  }>;
}

type CandidateChannel = readonly RankingCandidate[] | RetrievalChannelResult;

const CHANNEL_INDEX = new Map<RetrievalChannel, number>(
  CHANNELS.map((channel, index) => [channel, index]),
);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finiteNonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(name);
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
    "channelWeights",
    "temporalDecay",
    "rerankFeatureNames",
    "rerankWeights",
    "diversity",
  ], "ranking policy");
  assertExactRecord(policy.channelWeights, CHANNELS, "ranking policy channel weights");
  assertExactRecord(
    policy.temporalDecay,
    ["eventHalfLife", "floor"],
    "ranking policy temporal decay",
  );
  assertExactRecord(
    policy.rerankWeights,
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
    finiteNonnegative(policy.channelWeights[channel], `ranking weight ${channel}`);
  }
  positiveInteger(policy.temporalDecay.eventHalfLife, "temporal event half-life");
  const floor = finiteNonnegative(policy.temporalDecay.floor, "temporal floor");
  if (floor > 1) throw new TypeError("temporal floor");
  if (
    policy.rerankFeatureNames.length !== RERANK_FEATURE_NAMES.length
    || policy.rerankFeatureNames.some((name, index) => name !== RERANK_FEATURE_NAMES[index])
  ) throw new TypeError("rerank feature set");
  for (const name of RERANK_FEATURE_NAMES) {
    finiteNonnegative(policy.rerankWeights[name], `rerank weight ${name}`);
  }
  positiveInteger(policy.diversity.maxPerSource, "source diversity");
  positiveInteger(policy.diversity.maxPerEntity, "entity diversity");
}

export function weightedRrf(rank: number, weight: number, k = 60): number {
  positiveInteger(rank, "RRF rank");
  finiteNonnegative(weight, "RRF weight");
  positiveInteger(k, "RRF k");
  return weight / (k + rank);
}

function fromChannelResult(result: RetrievalChannelResult): readonly RankingCandidate[] {
  return result.candidates.map((candidate) => Object.freeze({
    id: `${candidate.item.kind}:${candidate.item.id}`,
    rank: candidate.rank,
    channel: candidate.channel,
    item: candidate.item,
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
  if (candidate.feedbackScore !== undefined) {
    const score = candidate.feedbackScore;
    if (!Number.isFinite(score) || score < -1 || score > 1) {
      throw new TypeError("retrieval feedback score");
    }
  }
  boundedKey(candidate.conflictGroupId, "conflict group id");
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
      const weight = policy.channelWeights[candidate.channel];
      return Object.freeze({
        channel: candidate.channel,
        rank: candidate.rank,
        weight,
        score: weightedRrf(candidate.rank, weight, policy.rrfK),
      });
    });
    const estimated = sources
      .map((candidate) => candidate.estimatedTokens)
      .filter((value): value is number => value !== undefined);
    const feedback = sources
      .map((candidate) => candidate.feedbackScore)
      .filter((value): value is number => value !== undefined)
      .sort((left, right) => right - left)[0] ?? 0;
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
      feedbackScore: feedback,
      contributions: Object.freeze(contributions),
      fusionScore: contributions.reduce((total, contribution) => total + contribution.score, 0),
      bestRank: Math.min(...contributions.map((contribution) => contribution.rank)),
    };
    fused.push(Object.freeze(output));
  }
  fused.sort((left, right) => (
    right.fusionScore - left.fusionScore
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
    verified: 1,
    active: 0.9,
    open: 0.9,
    blocked: 0.8,
    conflicted: 0.8,
    provisional: 0.45,
    candidate: 0.25,
    superseded: 0.15,
    retracted: 0,
    expired: 0,
    "erased-evidence": 0,
  }[item.status];
  const confidence = { high: 1, medium: 0.75, low: 0.4, guess: 0.1 }[item.confidence];
  return (status + confidence) / 2;
}

function provenanceFeature(item: RetrievalItem | undefined): number {
  if (item === undefined) return 0;
  if (
    item.verificationMethod === "committed-event"
    || item.verificationMethod === "session-checkpoint"
    || item.verificationMethod === "checkpoint-artifact"
    || item.verificationMethod === "open-follow-up"
  ) return 1;
  if (item.verificationMethod === "projection-chunk") return 0.65;
  return 0.35;
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
  const boundedDistance = distance > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(distance);
  return Math.max(
    policy.temporalDecay.floor,
    2 ** (-boundedDistance / policy.temporalDecay.eventHalfLife),
  );
}

function queryFeature(item: RetrievalItem | undefined, query: string): number {
  if (item === undefined) return 0;
  const needle = normalized(query);
  const exact = [item.id, item.normalizedKey, item.anchor]
    .filter((value): value is string => value !== null)
    .map(normalized);
  if (exact.includes(needle)) return 1;
  if (
    needle.length >= 3
    && exact.some((value) => value.length >= 3
      && (value.includes(needle) || needle.includes(value)))
  ) return 0.5;
  return 0;
}

function scopeFeature(item: RetrievalItem | undefined, request: InternalRetrievalRequest): number {
  if (item === undefined) return 0;
  const level = { project: 0, workspace: 1, branch: 2, session: 3 } as const;
  const requested = request.visibility
    ?? (request.sessionId === undefined ? "branch" : "session");
  const distance = Math.abs(level[requested] - level[item.visibility]);
  return Math.max(0, 1 - distance / 3);
}

function conflictFeature(candidate: FusedCandidate): number {
  if (candidate.conflictGroupId !== null || candidate.item?.status === "conflicted") return 1;
  if (candidate.item?.status === "superseded") return 0.25;
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
    sourceFreshness: candidate.item?.freshness === "fresh" ? 1 : 0,
    retrievalFeedback: (candidate.feedbackScore + 1) / 2,
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
      (total, name) => total + values[name] * policy.rerankWeights[name],
      0,
    );
    return Object.freeze({
      ...candidate,
      features: values,
      featureScore,
      rerankScore: candidate.fusionScore + featureScore,
    });
  });
  reranked.sort((left, right) => (
    right.rerankScore - left.rerankScore
    || right.fusionScore - left.fusionScore
    || left.bestRank - right.bestRank
    || compareText(left.id, right.id)
  ));
  return Object.freeze(reranked);
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
  candidates: readonly RerankedCandidate[],
  bounds: Readonly<{ readonly limit: number; readonly tokenBudget: number }>,
  policy: RankingPolicy = DEFAULT_RANKING_POLICY,
): RankedSelection {
  assertPolicy(policy);
  positiveInteger(bounds.limit, "retrieval result limit");
  positiveInteger(bounds.tokenBudget, "retrieval token budget");
  const ordered = [...candidates].sort((left, right) => (
    right.rerankScore - left.rerankScore
    || right.fusionScore - left.fusionScore
    || left.bestRank - right.bestRank
    || compareText(left.id, right.id)
  ));
  const seen = new Set<string>();
  for (const candidate of ordered) {
    if (seen.has(candidate.id)) throw new TypeError("duplicate reranked candidate id");
    seen.add(candidate.id);
  }

  const groups = new Map<string, RerankedCandidate[]>();
  for (const candidate of ordered) {
    if (candidate.conflictGroupId === null) continue;
    const group = groups.get(candidate.conflictGroupId) ?? [];
    group.push(candidate);
    groups.set(candidate.conflictGroupId, group);
  }

  const selected: RerankedCandidate[] = [];
  const selectedIds = new Set<string>();
  const processedGroups = new Set<string>();
  const sourceCounts = new Map<string, number>();
  const entityCounts = new Map<string, number>();
  let usedTokens = 0;
  let haltedForHighImpactConflict = false;
  const dropped = { diversity: 0, resultLimit: 0, tokenBudget: 0 };

  const admit = (candidate: RerankedCandidate, bypassDiversity: boolean): "selected" | "limit" | "budget" | "diversity" => {
    if (selected.length >= bounds.limit) {
      dropped.resultLimit += 1;
      return "limit";
    }
    const tokens = candidate.estimatedTokens ?? estimateCandidateTokens(candidate);
    if (usedTokens + tokens > bounds.tokenBudget) {
      dropped.tokenBudget += 1;
      return "budget";
    }
    if (!bypassDiversity && (
      (candidate.sourceKey !== null
        && (sourceCounts.get(candidate.sourceKey) ?? 0) >= policy.diversity.maxPerSource)
      || (candidate.entityKey !== null
        && (entityCounts.get(candidate.entityKey) ?? 0) >= policy.diversity.maxPerEntity)
    )) {
      dropped.diversity += 1;
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

  const conflicts: RankedConflictGroup[] = [];
  for (const [conflictGroupId, members] of groups) {
    const selectedMemberCount = members.filter((member) => selectedIds.has(member.id)).length;
    const truncated = selectedMemberCount < members.length;
    conflicts.push(Object.freeze({
      conflictGroupId,
      totalMemberCount: members.length,
      selectedMemberCount,
      highImpact: members.some((member) => member.highImpact),
      truncated,
      cursor: truncated
        ? conflictCursor(policy, conflictGroupId, selectedMemberCount)
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
