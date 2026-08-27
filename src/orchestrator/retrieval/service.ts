import { ProjectionLagError } from "../projections/coordinator.js";
import { parseProjectionManifest, type ProjectionManifestV1 } from "../projections/manifest.js";
import {
  InternalRetrievalError,
  validateInternalRetrievalRequest,
  type InternalRetrievalRequest,
  type InternalRetrievalResult,
  type InternalRetrievalResultItem,
  type ProjectionLeaseProvider,
  type RetrievalCandidate,
  type RetrievalCandidateCollection,
  type RetrievalCandidateRepository,
  type RetrievalChannelResult,
  type RetrievalItem,
  type ValidatedInternalRetrievalRequest,
  type VectorCacheManifestV1,
  type VectorCandidateChannel,
  type VectorChannelFailureCode,
  type VectorChannelResult,
} from "./contracts.js";
import {
  buildRetrievalExplanation,
  type RedactedDropCounts,
  type RedactedDropReason,
  type RetrievalChannelContribution,
  type RetrievalExplanation,
} from "./explain.js";
import {
  branchVisible,
  freshnessVisible,
  sessionVisible,
  statusVisible,
  temporalVisible,
  workspaceVisible,
} from "./eligibility.js";
import {
  DEFAULT_RANKING_POLICY,
  RERANK_FEATURE_NAMES,
  addRationalScores,
  compareRationalScores,
  estimateCandidateTokens,
  formatRationalScore,
  fuseCandidates,
  rerankCandidates,
  selectRankedCandidates,
  validateCustomRanking,
  type FusedCandidate,
  type RankedConflictGroup,
  type RankedSelection,
  type RankingCandidate,
  type RationalScore,
  type RetrievalRanker,
} from "./ranking.js";
import {
  disabledVectorChannel,
  parseVectorCacheManifest,
  unavailableVectorChannel,
  withVectorDeadline,
} from "./vector-cache.js";

export interface InternalRetrievalServiceOptions {
  readonly projections: ProjectionLeaseProvider;
  readonly candidates: RetrievalCandidateRepository;
  readonly ranker?: RetrievalRanker;
  readonly vectorChannel?: VectorCandidateChannel;
}

export interface VectorChannelDiagnostic {
  readonly used: boolean;
  readonly failureCode: VectorChannelFailureCode | null;
  readonly candidateCount: number;
  readonly manifest: VectorCacheManifestV1 | null;
}

export interface InternalRetrievalChannelDiagnostics {
  readonly vector: VectorChannelDiagnostic;
}

export interface RankedInternalRetrievalResultItem extends InternalRetrievalResultItem {
  readonly conflictGroupId: string | null;
}

export interface RankedInternalRetrievalResult extends InternalRetrievalResult {
  readonly items: readonly RankedInternalRetrievalResultItem[];
  readonly eligibleCount: number;
  readonly rankingPolicyVersion: string;
  readonly rerankFeatureNames: typeof RERANK_FEATURE_NAMES;
  readonly redactedDropCounts: RedactedDropCounts;
  readonly channelContributions: readonly RetrievalChannelContribution[];
  readonly requiredEventPosition: bigint;
  readonly publishedEventPosition: bigint;
  readonly conflicts: readonly RankedConflictGroup[];
  readonly conflictTruncated: boolean;
  readonly conflictCursor: string | null;
  readonly channels: InternalRetrievalChannelDiagnostics;
  readonly explanation?: RetrievalExplanation;
  readonly explanationTruncated: boolean;
}

type MutableDropCounts = Record<RedactedDropReason, number>;

interface FilteredCandidates {
  readonly collection: RetrievalCandidateCollection;
  readonly defensiveDrops: Readonly<MutableDropCounts>;
}

function emptyDropCounts(): MutableDropCounts {
  return {
    scopeDenied: 0,
    temporalDenied: 0,
    statusDenied: 0,
    freshnessDenied: 0,
    eligibilityDenied: 0,
    candidateBound: 0,
    diversity: 0,
    resultLimit: 0,
    tokenBudget: 0,
    conflictSuppressed: 0,
  };
}

function denialReason(
  item: RetrievalItem,
  request: ValidatedInternalRetrievalRequest,
): RedactedDropReason | null {
  if (
    item.projectId !== request.binding.projectId
    || !workspaceVisible(item, request.binding, request)
    || !branchVisible(item, request.binding, request)
    || !sessionVisible(item, request)
  ) return "scopeDenied";
  if (!statusVisible(item)) return "statusDenied";
  if (!temporalVisible(item, request)) return "temporalDenied";
  if (!freshnessVisible(item)) return "freshnessDenied";
  return null;
}

/**
 * Candidate repositories promise eligible rows. The service repeats every
 * predicate before rank fusion so a conflict member can never inherit another
 * member's scope or temporal authority.
 */
function filterCandidates(
  eligible: RetrievalCandidateCollection,
  request: ValidatedInternalRetrievalRequest,
): FilteredCandidates {
  const drops = emptyDropCounts();
  const channels: RetrievalChannelResult[] = [];
  const unique = new Set<string>();
  const deniedUnique = new Set<string>();
  const deniedByConflictGroup = new Map<string, Set<string>>();
  for (const channel of eligible.channels) {
    const candidates: RetrievalCandidate[] = [];
    for (const candidate of channel.candidates) {
      if (candidate.channel !== channel.channel) {
        throw new InternalRetrievalError("RETRIEVAL_PROJECTION_INVALID");
      }
      const reason = denialReason(candidate.item, request);
      if (reason !== null) {
        drops[reason] += 1;
        const deniedKey = `${candidate.item.kind}:${candidate.item.id}`;
        deniedUnique.add(deniedKey);
        if (candidate.item.conflictGroupId !== null) {
          const denied = deniedByConflictGroup.get(candidate.item.conflictGroupId) ?? new Set<string>();
          denied.add(deniedKey);
          deniedByConflictGroup.set(candidate.item.conflictGroupId, denied);
        }
        continue;
      }
      const ranked = Object.freeze({
        ...candidate,
        rank: candidates.length + 1,
      });
      candidates.push(ranked);
      unique.add(`${candidate.item.kind}:${candidate.item.id}`);
    }
    channels.push(Object.freeze({
      channel: channel.channel,
      candidates: Object.freeze(candidates),
    }));
  }
  const conflictGroups = eligible.conflictGroups.map((group) => {
    const denied = deniedByConflictGroup.get(group.conflictGroupId)?.size ?? 0;
    const returnedMemberCount = [...unique].filter((key) => channels.some((channel) => (
      channel.candidates.some((candidate) => (
        `${candidate.item.kind}:${candidate.item.id}` === key
        && candidate.item.conflictGroupId === group.conflictGroupId
      ))
    ))).length;
    const eligibleMemberCount = Math.max(
      returnedMemberCount,
      group.eligibleMemberCount - denied,
    );
    const truncated = returnedMemberCount < eligibleMemberCount;
    return Object.freeze({
      conflictGroupId: group.conflictGroupId,
      eligibleMemberCount,
      returnedMemberCount,
      truncated,
      cursor: truncated ? group.cursor : null,
    });
  });
  return Object.freeze({
    collection: Object.freeze({
      channels: Object.freeze(channels),
      eligibleItemCount: Math.max(unique.size, eligible.eligibleItemCount - deniedUnique.size),
      droppedItemCount: eligible.droppedItemCount
        + Object.values(drops).reduce((total, count) => total + count, 0),
      truncated: eligible.truncated,
      conflictGroups: Object.freeze(conflictGroups),
    }),
    defensiveDrops: Object.freeze(drops),
  });
}

function rankingChannels(
  eligible: RetrievalCandidateCollection,
): readonly (readonly RankingCandidate[])[] {
  const conflictGroups = new Map(eligible.conflictGroups.map((group) => [
    group.conflictGroupId,
    group,
  ]));
  return Object.freeze(eligible.channels.map((channel) => Object.freeze(
    channel.candidates.map((candidate): RankingCandidate => {
      const groupId = candidate.item.conflictGroupId;
      const group = groupId === null ? undefined : conflictGroups.get(groupId);
      const rankable: RankingCandidate = {
        id: `${candidate.item.kind}:${candidate.item.id}`,
        rank: candidate.rank,
        channel: candidate.channel,
        item: candidate.item,
        conflictGroupId: groupId,
        highImpact: groupId !== null && candidate.item.status === "conflicted",
        sourceKey: candidate.item.sourceEventPosition.toString(),
        entityKey: candidate.item.normalizedKey,
        estimatedTokens: estimateCandidateTokens({
          id: `${candidate.item.kind}:${candidate.item.id}`,
          item: candidate.item,
        }),
        feedbackScoreUnits: candidate.item.retrievalFeedbackScoreUnits,
        ...(group === undefined ? {} : {
          conflictTotalMemberCount: group.eligibleMemberCount,
          conflictCursor: group.cursor,
        }),
      };
      return Object.freeze(rankable);
    }),
  )));
}

function selectionReason(candidate: FusedCandidate): InternalRetrievalResultItem["selectionReason"] {
  const contribution = [...candidate.contributions].sort((left, right) => (
    compareRationalScores(right.score, left.score)
    || left.rank - right.rank
    || (left.channel < right.channel ? -1 : left.channel > right.channel ? 1 : 0)
  ))[0];
  if (contribution === undefined) {
    throw new InternalRetrievalError("RETRIEVAL_PROJECTION_INVALID");
  }
  return contribution.channel;
}

function resultItems(selection: RankedSelection): readonly RankedInternalRetrievalResultItem[] {
  return Object.freeze(selection.candidates.map((candidate) => {
    if (candidate.item === undefined) {
      throw new InternalRetrievalError("RETRIEVAL_PROJECTION_INVALID");
    }
    return Object.freeze({
      ...candidate.item,
      channels: Object.freeze(candidate.contributions.map((contribution) => contribution.channel)),
      selectionReason: selectionReason(candidate),
      conflictGroupId: candidate.conflictGroupId,
    });
  }));
}

function channelContributions(
  eligible: RetrievalCandidateCollection,
  fused: readonly FusedCandidate[],
  selectedIds: ReadonlySet<string>,
): readonly RetrievalChannelContribution[] {
  const zeroScore: RationalScore = Object.freeze({ numerator: 0n, denominator: 1n });
  return Object.freeze(eligible.channels.map((channel) => {
    const ranks = channel.candidates.map((candidate) => candidate.rank);
    const relevant = fused.filter((candidate) => (
      candidate.contributions.some((contribution) => contribution.channel === channel.channel)
    ));
    return Object.freeze({
      channel: channel.channel,
      eligibleCount: channel.candidates.length,
      selectedCount: relevant.filter((candidate) => selectedIds.has(candidate.id)).length,
      bestRank: ranks.length === 0 ? null : Math.min(...ranks),
      worstRank: ranks.length === 0 ? null : Math.max(...ranks),
      fusionContribution: formatRationalScore(relevant.reduce((total, candidate) => (
        candidate.contributions
          .filter((contribution) => contribution.channel === channel.channel)
          .reduce(
            (subtotal, contribution) => addRationalScores(subtotal, contribution.score),
            total,
          )
      ), zeroScore)),
    });
  }));
}

function redactedDropCounts(
  eligible: RetrievalCandidateCollection,
  defensiveDrops: Readonly<MutableDropCounts>,
  selection: RankedSelection,
): RedactedDropCounts {
  const counts = emptyDropCounts();
  for (const [reason, count] of Object.entries(defensiveDrops) as Array<[
    RedactedDropReason,
    number,
  ]>) counts[reason] += count;
  counts.eligibilityDenied += eligible.droppedItemCount;
  const materialized = new Set(eligible.channels.flatMap((channel) => (
    channel.candidates.map((candidate) => `${candidate.item.kind}:${candidate.item.id}`)
  ))).size;
  counts.candidateBound += Math.max(
    eligible.truncated ? 1 : 0,
    eligible.eligibleItemCount - materialized,
  );
  counts.diversity += selection.droppedByReason.diversity;
  counts.resultLimit += selection.droppedByReason.resultLimit;
  counts.tokenBudget += selection.droppedByReason.tokenBudget;
  counts.conflictSuppressed += selection.droppedByReason.conflictSuppressed;
  const byReason = Object.freeze(counts);
  return Object.freeze({
    total: Object.values(byReason).reduce((total, count) => total + count, 0),
    byReason,
  });
}

function withExplanation(
  base: Omit<RankedInternalRetrievalResult, "explanation" | "explanationTruncated">,
  request: ValidatedInternalRetrievalRequest,
  manifest: ProjectionManifestV1,
): RankedInternalRetrievalResult {
  if (!request.explain) {
    return Object.freeze({ ...base, explanationTruncated: false });
  }
  const conflictCursor = base.conflicts.find((conflict) => conflict.cursor !== null)?.cursor ?? null;
  const explanation = buildRetrievalExplanation({
    eligibleCount: base.eligibleCount,
    redactedDropCounts: base.redactedDropCounts,
    channelContributions: base.channelContributions,
    manifest,
    requiredEventPosition: base.requiredEventPosition,
    publishedEventPosition: base.publishedEventPosition,
    rankingPolicyVersion: base.rankingPolicyVersion,
    rerankFeatureNames: base.rerankFeatureNames,
    conflicts: Object.freeze({
      groupCount: base.conflicts.length,
      totalMemberCount: base.conflicts.reduce(
        (total, conflict) => total + conflict.totalMemberCount,
        0,
      ),
      truncated: base.conflictTruncated,
      cursor: conflictCursor,
    }),
    truncated: base.truncated,
  });
  if (Buffer.byteLength(JSON.stringify(explanation), "utf8") > request.explainByteLimit) {
    return Object.freeze({ ...base, explanationTruncated: true });
  }
  return Object.freeze({ ...base, explanation, explanationTruncated: false });
}

function vectorDiagnostic(
  result: VectorChannelResult,
  request: ValidatedInternalRetrievalRequest,
): VectorChannelDiagnostic {
  if (!Array.isArray(result.candidates) || result.candidates.length > request.candidateLimit) {
    throw new TypeError("VECTOR_CHANNEL_INVALID");
  }
  if (!result.used) {
    if (result.candidates.length !== 0 || result.manifest !== null) {
      throw new TypeError("VECTOR_CHANNEL_INVALID");
    }
    if (result.failureCode === null) {
      return Object.freeze({
        used: false,
        failureCode: null,
        candidateCount: 0,
        manifest: null,
      });
    }
    if (result.failureCode === "PROVIDER_UNAVAILABLE") {
      return Object.freeze({
        used: false,
        failureCode: "PROVIDER_UNAVAILABLE",
        candidateCount: 0,
        manifest: null,
      });
    }
    throw new TypeError("VECTOR_CHANNEL_INVALID");
  }
  if (result.failureCode !== null) throw new TypeError("VECTOR_CHANNEL_INVALID");
  if (result.manifest === null) throw new TypeError("VECTOR_CHANNEL_INVALID");
  const seen = new Set<string>();
  let candidateCount = 0;
  for (const candidate of result.candidates) {
    if (
      typeof candidate.candidateId !== "string"
      || candidate.candidateId.length === 0
      || Buffer.byteLength(candidate.candidateId, "utf8") > 4_096
      || !Number.isSafeInteger(candidate.rank)
      || candidate.rank < 1
      || typeof candidate.similarity !== "number"
      || !Number.isFinite(candidate.similarity)
      || candidate.similarity < -1
      || candidate.similarity > 1
    ) throw new TypeError("VECTOR_CHANNEL_INVALID");
    const key = `${candidate.item.kind}:${candidate.item.id}`;
    if (seen.has(key) || denialReason(candidate.item, request) !== null) continue;
    seen.add(key);
    candidateCount += 1;
  }
  const manifest = parseVectorCacheManifest(result.manifest);
  return Object.freeze({
    used: true,
    failureCode: null,
    candidateCount,
    manifest,
  });
}

async function searchOptionalVectorChannel(
  channel: VectorCandidateChannel | undefined,
  request: ValidatedInternalRetrievalRequest,
  lease: Parameters<VectorCandidateChannel["search"]>[1],
): Promise<VectorChannelDiagnostic> {
  if (!request.vector.enabled || channel === undefined) {
    return vectorDiagnostic(disabledVectorChannel(), request);
  }
  try {
    const result = await withVectorDeadline(
      request.consistency.deadlineMs,
      (signal) => channel.search(request, lease, signal),
    );
    return vectorDiagnostic(result, request);
  } catch {
    return vectorDiagnostic(unavailableVectorChannel(), request);
  }
}

export class InternalRetrievalService {
  readonly #projections: ProjectionLeaseProvider;
  readonly #candidates: RetrievalCandidateRepository;
  readonly #customRanker: RetrievalRanker | undefined;
  readonly #vectorChannel: VectorCandidateChannel | undefined;

  constructor(options: InternalRetrievalServiceOptions) {
    this.#projections = options.projections;
    this.#candidates = options.candidates;
    this.#customRanker = options.ranker;
    this.#vectorChannel = options.vectorChannel;
  }

  async retrieve(input: InternalRetrievalRequest): Promise<RankedInternalRetrievalResult> {
    const request = validateInternalRetrievalRequest(input);
    const lease = await this.#projections.pin(request.binding, request.consistency);
    try {
      let manifest: ProjectionManifestV1;
      try {
        manifest = parseProjectionManifest(lease.manifest, request.binding);
      } catch {
        throw new InternalRetrievalError("PROJECTION_SCOPE_MISMATCH");
      }
      const available = BigInt(manifest.terminalEventPosition);
      if (available < request.consistency.requiredEventPosition) {
        throw new ProjectionLagError(request.consistency.requiredEventPosition, available);
      }
      const collected = this.#candidates.collectEligible(lease, request);
      const filtered = filterCandidates(collected, request);
      const vector = await searchOptionalVectorChannel(this.#vectorChannel, request, lease);
      const fused = fuseCandidates(rankingChannels(filtered.collection), DEFAULT_RANKING_POLICY);
      const ranked = this.#customRanker === undefined
        ? rerankCandidates(fused, request, DEFAULT_RANKING_POLICY)
        : validateCustomRanking(this.#customRanker.select(fused, request), fused);
      const selection = selectRankedCandidates(ranked, {
        limit: request.limit,
        tokenBudget: request.tokenBudget,
      }, DEFAULT_RANKING_POLICY);
      const items = resultItems(selection);
      const conflicts = selection.conflicts;
      const candidateCount = fused.length;
      const rankedTruncated = selection.truncated;

      const selectedIds = new Set(items.map((item) => `${item.kind}:${item.id}`));
      const dropCounts = redactedDropCounts(
        collected,
        filtered.defensiveDrops,
        selection,
      );
      const truncated = collected.truncated
        || rankedTruncated
        || candidateCount > items.length;
      const conflictTruncated = conflicts.some((conflict) => conflict.truncated);
      const conflictCursor = conflicts.find((conflict) => conflict.cursor !== null)?.cursor ?? null;
      const base = Object.freeze({
        items,
        generation: manifest.generation,
        terminalEventPosition: available,
        candidateCount,
        truncated,
        eligibleCount: filtered.collection.eligibleItemCount,
        rankingPolicyVersion: DEFAULT_RANKING_POLICY.version,
        rerankFeatureNames: RERANK_FEATURE_NAMES,
        redactedDropCounts: dropCounts,
        channelContributions: channelContributions(filtered.collection, fused, selectedIds),
        requiredEventPosition: request.consistency.requiredEventPosition,
        publishedEventPosition: available,
        conflicts,
        conflictTruncated,
        conflictCursor,
        channels: Object.freeze({ vector }),
      });
      return withExplanation(base, request, manifest);
    } finally {
      lease.close();
    }
  }
}
