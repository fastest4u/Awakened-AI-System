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
  type RetrievalRanker,
  type ValidatedInternalRetrievalRequest,
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
  estimateCandidateTokens,
  fuseCandidates,
  rerankCandidates,
  selectRankedCandidates,
  type FusedCandidate,
  type RankedConflictGroup,
  type RankedSelection,
  type RankingCandidate,
} from "./ranking.js";

export interface InternalRetrievalServiceOptions {
  readonly projections: ProjectionLeaseProvider;
  readonly candidates: RetrievalCandidateRepository;
  readonly ranker?: RetrievalRanker;
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
  readonly explanation?: RetrievalExplanation;
  readonly explanationTruncated: boolean;
}

type MutableDropCounts = Record<RedactedDropReason, number>;

interface FilteredCandidates {
  readonly collection: RetrievalCandidateCollection;
  readonly defensiveDrops: Readonly<MutableDropCounts>;
}

interface DefaultRankingOutcome {
  readonly fused: readonly FusedCandidate[];
  readonly selection: RankedSelection;
  readonly items: readonly RankedInternalRetrievalResultItem[];
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
  for (const channel of eligible.channels) {
    const candidates: RetrievalCandidate[] = [];
    for (const candidate of channel.candidates) {
      if (candidate.channel !== channel.channel) {
        throw new InternalRetrievalError("RETRIEVAL_PROJECTION_INVALID");
      }
      const reason = denialReason(candidate.item, request);
      if (reason !== null) {
        drops[reason] += 1;
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
  return Object.freeze({
    collection: Object.freeze({
      channels: Object.freeze(channels),
      eligibleItemCount: unique.size,
      droppedItemCount: eligible.droppedItemCount
        + Object.values(drops).reduce((total, count) => total + count, 0),
      truncated: eligible.truncated,
    }),
    defensiveDrops: Object.freeze(drops),
  });
}

function conflictGroupId(item: RetrievalItem): string | null {
  return item.status === "conflicted" ? item.normalizedKey : null;
}

function rankingChannels(
  eligible: RetrievalCandidateCollection,
): readonly (readonly RankingCandidate[])[] {
  return Object.freeze(eligible.channels.map((channel) => Object.freeze(
    channel.candidates.map((candidate): RankingCandidate => {
      const groupId = conflictGroupId(candidate.item);
      const rankable: RankingCandidate = {
        id: `${candidate.item.kind}:${candidate.item.id}`,
        rank: candidate.rank,
        channel: candidate.channel,
        item: candidate.item,
        conflictGroupId: groupId,
        highImpact: groupId !== null,
        sourceKey: candidate.item.sourceEventPosition.toString(),
        entityKey: candidate.item.normalizedKey,
        estimatedTokens: estimateCandidateTokens({
          id: `${candidate.item.kind}:${candidate.item.id}`,
          item: candidate.item,
        }),
      };
      return Object.freeze(rankable);
    }),
  )));
}

function selectionReason(candidate: FusedCandidate): InternalRetrievalResultItem["selectionReason"] {
  const contribution = [...candidate.contributions].sort((left, right) => (
    right.score - left.score
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

function defaultRank(
  fused: readonly FusedCandidate[],
  request: ValidatedInternalRetrievalRequest,
): DefaultRankingOutcome {
  const reranked = rerankCandidates(fused, request, DEFAULT_RANKING_POLICY);
  const selection = selectRankedCandidates(reranked, {
    limit: request.limit,
    tokenBudget: request.tokenBudget,
  }, DEFAULT_RANKING_POLICY);
  return Object.freeze({
    fused,
    selection,
    items: resultItems(selection),
  });
}

function customRank(
  ranker: RetrievalRanker,
  eligible: RetrievalCandidateCollection,
  request: ValidatedInternalRetrievalRequest,
  manifest: ProjectionManifestV1,
): Readonly<{
  readonly result: InternalRetrievalResult;
  readonly items: readonly RankedInternalRetrievalResultItem[];
}> {
  const allowed = new Map<string, RetrievalItem>();
  for (const channel of eligible.channels) {
    for (const candidate of channel.candidates) {
      allowed.set(`${candidate.item.kind}:${candidate.item.id}`, candidate.item);
    }
  }
  const result = ranker.select(eligible, request, manifest);
  const seen = new Set<string>();
  const items: RankedInternalRetrievalResultItem[] = [];
  for (const selected of result.items) {
    const key = `${selected.kind}:${selected.id}`;
    const item = allowed.get(key);
    if (item === undefined || seen.has(key)) continue;
    seen.add(key);
    items.push(Object.freeze({
      ...item,
      channels: Object.freeze([...selected.channels]),
      selectionReason: selected.selectionReason,
      conflictGroupId: conflictGroupId(item),
    }));
  }
  return Object.freeze({ result, items: Object.freeze(items) });
}

function channelContributions(
  eligible: RetrievalCandidateCollection,
  fused: readonly FusedCandidate[],
  selectedIds: ReadonlySet<string>,
): readonly RetrievalChannelContribution[] {
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
      fusionContribution: relevant.reduce((total, candidate) => (
        total + candidate.contributions
          .filter((contribution) => contribution.channel === channel.channel)
          .reduce((subtotal, contribution) => subtotal + contribution.score, 0)
      ), 0),
    });
  }));
}

function redactedDropCounts(
  eligible: RetrievalCandidateCollection,
  defensiveDrops: Readonly<MutableDropCounts>,
  selection: RankedSelection | null,
): RedactedDropCounts {
  const counts = emptyDropCounts();
  for (const [reason, count] of Object.entries(defensiveDrops) as Array<[
    RedactedDropReason,
    number,
  ]>) counts[reason] += count;
  counts.eligibilityDenied += eligible.droppedItemCount;
  counts.candidateBound += eligible.truncated ? 1 : 0;
  if (selection !== null) {
    counts.diversity += selection.droppedByReason.diversity;
    counts.resultLimit += selection.droppedByReason.resultLimit;
    counts.tokenBudget += selection.droppedByReason.tokenBudget;
  }
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

export class InternalRetrievalService {
  readonly #projections: ProjectionLeaseProvider;
  readonly #candidates: RetrievalCandidateRepository;
  readonly #customRanker: RetrievalRanker | undefined;

  constructor(options: InternalRetrievalServiceOptions) {
    this.#projections = options.projections;
    this.#candidates = options.candidates;
    this.#customRanker = options.ranker;
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
      const fused = fuseCandidates(rankingChannels(filtered.collection), DEFAULT_RANKING_POLICY);

      let items: readonly RankedInternalRetrievalResultItem[];
      let conflicts: readonly RankedConflictGroup[];
      let selection: RankedSelection | null;
      let candidateCount: number;
      let rankedTruncated: boolean;
      if (this.#customRanker === undefined) {
        const ranked = defaultRank(fused, request);
        items = ranked.items;
        conflicts = ranked.selection.conflicts;
        selection = ranked.selection;
        candidateCount = ranked.fused.length;
        rankedTruncated = ranked.selection.truncated;
      } else {
        const ranked = customRank(this.#customRanker, filtered.collection, request, manifest);
        items = ranked.items;
        conflicts = Object.freeze([]);
        selection = null;
        candidateCount = ranked.result.candidateCount;
        rankedTruncated = ranked.result.truncated || items.length < ranked.result.items.length;
      }

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
        eligibleCount: fused.length,
        rankingPolicyVersion: DEFAULT_RANKING_POLICY.version,
        rerankFeatureNames: RERANK_FEATURE_NAMES,
        redactedDropCounts: dropCounts,
        channelContributions: channelContributions(filtered.collection, fused, selectedIds),
        requiredEventPosition: request.consistency.requiredEventPosition,
        publishedEventPosition: available,
        conflicts,
        conflictTruncated,
        conflictCursor,
      });
      return withExplanation(base, request, manifest);
    } finally {
      lease.close();
    }
  }
}
