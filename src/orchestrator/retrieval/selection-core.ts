import {
  InternalRetrievalError,
  type InternalRetrievalResultItem,
  type RetrievalCandidate,
  type RetrievalCandidateCollection,
  type RetrievalChannel,
  type RetrievalChannelResult,
  type RetrievalItem,
  type ValidatedInternalRetrievalRequest,
} from "./contracts.js";
import type { RedactedDropCounts, RedactedDropReason } from "./explain.js";
import {
  branchVisible, freshnessVisible, sessionVisible, statusVisible, temporalVisible, workspaceVisible,
} from "./eligibility.js";
import {
  compareRationalScores, estimateCandidateTokens,
  type FusedCandidate, type RankedSelection, type RankingCandidate,
} from "./ranking.js";

type MutableDropCounts = Record<RedactedDropReason, number>;

export interface FilteredCandidates {
  readonly collection: RetrievalCandidateCollection;
  readonly defensiveDrops: RedactedDropCounts;
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
export function filterCandidates(
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
    defensiveDrops: Object.freeze({
      total: Object.values(drops).reduce((total, count) => total + count, 0),
      byReason: Object.freeze(drops),
    }),
  });
}

export function rankingChannels(
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

export function selectionReason(candidate: FusedCandidate): RetrievalChannel {
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

export function resultItems(selection: RankedSelection): readonly InternalRetrievalResultItem[] {
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
