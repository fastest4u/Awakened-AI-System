import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  BranchScopeId,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import type {
  InternalRetrievalRequest,
  RetrievalItem,
} from "../src/orchestrator/retrieval/contracts.js";
import {
  DEFAULT_RANKING_POLICY,
  RANKING_UNIT_SCALE,
  fuseCandidates,
  rerankCandidates,
  selectRankedCandidates,
  weightedRrf,
  type RankingPolicy,
} from "../src/orchestrator/retrieval/ranking.js";

const PROJECT_ID = "1".repeat(64) as ProjectId;
const WORKSPACE_ID = "2".repeat(64) as WorkspaceId;
const BRANCH_SCOPE_ID = "00000000-0000-4000-8000-000000000601" as BranchScopeId;
const SESSION_ID = "00000000-0000-4000-8000-000000000602";

const BINDING: ProjectBinding = Object.freeze({
  projectId: PROJECT_ID,
  vaultId: "3".repeat(64) as VaultId,
  storeId: "4".repeat(64) as StoreId,
  workspaceId: WORKSPACE_ID,
  branchScopeId: BRANCH_SCOPE_ID,
  branchRef: "refs/heads/task-6",
  sessionId: null,
});

const REQUEST: InternalRetrievalRequest = Object.freeze({
  binding: BINDING,
  query: "decision:ranked",
  limit: 10,
  tokenBudget: 1_200,
  consistency: Object.freeze({ requiredEventPosition: 100n, deadlineMs: 100 }),
  sessionId: SESSION_ID,
  visibility: "session",
  validAt: "2026-08-24T00:00:00.000Z",
  knownAt: 100n,
});

function item(
  id: string,
  overrides: Partial<RetrievalItem> = {},
): RetrievalItem {
  return Object.freeze({
    id,
    kind: "canonical",
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    branchScopeId: BRANCH_SCOPE_ID,
    branchRef: "refs/heads/task-6",
    sessionId: SESSION_ID,
    visibility: "session",
    status: "verified",
    confidence: "high",
    verificationMethod: "committed-event",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    knownFromEventPosition: 10n,
    sourceEventPosition: 90n,
    summary: `summary-${id}`,
    normalizedKey: `decision:${id}`,
    anchor: null,
    freshness: "fresh",
    conflictGroupId: null,
    supersedingItemId: null,
    retrievalFeedbackScoreUnits: 0,
    ...overrides,
  });
}

describe("deterministic retrieval ranking", () => {
  it("uses frozen versioned weighted RRF and stable identifier tie breaks", () => {
    assert.deepEqual(weightedRrf(1, 2 * RANKING_UNIT_SCALE), {
      numerator: 2n,
      denominator: 61n,
    });
    assert.equal(Object.isFrozen(DEFAULT_RANKING_POLICY), true);
    assert.equal(Object.isFrozen(DEFAULT_RANKING_POLICY.channelWeightUnits), true);
    assert.equal(Object.isFrozen(DEFAULT_RANKING_POLICY.temporalDecay), true);
    assert.equal(Object.isFrozen(DEFAULT_RANKING_POLICY.rerankFeatureNames), true);
    assert.equal(Object.isFrozen(DEFAULT_RANKING_POLICY.diversity), true);

    const channels = [
      [{ id: "A", rank: 1, channel: "exact" as const }],
      [
        { id: "B", rank: 1, channel: "lexical" as const },
        { id: "A", rank: 2, channel: "lexical" as const },
      ],
    ] as const;
    const permuted = [
      [...channels[1]].reverse(),
      channels[0],
    ] as const;

    const fused = fuseCandidates(channels, DEFAULT_RANKING_POLICY);
    const repeated = fuseCandidates(permuted, DEFAULT_RANKING_POLICY);

    assert.deepEqual(fused.map((candidate) => candidate.id), ["A", "B"]);
    assert.deepEqual(
      repeated.map(({ id, fusionScore }) => ({ id, fusionScore })),
      fused.map(({ id, fusionScore }) => ({ id, fusionScore })),
    );
    assert.deepEqual(
      fused[0]?.contributions.map(({ channel, rank }) => ({ channel, rank })),
      [{ channel: "exact", rank: 1 }, { channel: "lexical", rank: 2 }],
    );

    const policyWithUnknownWeight = {
      ...DEFAULT_RANKING_POLICY,
      channelWeightUnits: {
        ...DEFAULT_RANKING_POLICY.channelWeightUnits,
        covertProvider: 1,
      },
    } as unknown as RankingPolicy;
    assert.throws(
      () => fuseCandidates([], policyWithUnknownWeight),
      /ranking policy channel weights/u,
    );
  });

  it("compares exact equal policy scores by best rank instead of floating-point residue", () => {
    const fused = fuseCandidates([
      [
        { id: "A", rank: 4, channel: "exact" as const },
        { id: "B", rank: 12, channel: "exact" as const },
      ],
      [
        { id: "A", rank: 66, channel: "alias" as const },
        { id: "B", rank: 36, channel: "alias" as const },
      ],
    ], DEFAULT_RANKING_POLICY);

    assert.deepEqual(fused.map(({ id, bestRank }) => ({ id, bestRank })), [
      { id: "A", bestRank: 4 },
      { id: "B", bestRank: 12 },
    ]);
    assert.deepEqual(fused[0]?.fusionScore, fused[1]?.fusionScore);
  });

  it("reranks deterministically with only the frozen feature set and never changes membership", () => {
    const provisional = item("provisional", {
      status: "provisional",
      confidence: "low",
      verificationMethod: "unverified-memory",
    });
    const verified = item("verified");
    const fused = fuseCandidates([[
      {
        id: "canonical:provisional",
        rank: 1,
        channel: "lexical",
        item: provisional,
      },
      {
        id: "canonical:verified",
        rank: 2,
        channel: "lexical",
        item: verified,
      },
    ]], DEFAULT_RANKING_POLICY);

    const ranked = rerankCandidates(fused, REQUEST, DEFAULT_RANKING_POLICY);
    const repeated = rerankCandidates([...fused].reverse(), REQUEST, DEFAULT_RANKING_POLICY);

    assert.deepEqual(ranked.map((candidate) => candidate.id), [
      "canonical:verified",
      "canonical:provisional",
    ]);
    assert.deepEqual(
      repeated.map(({ id, rerankScore }) => ({ id, rerankScore })),
      ranked.map(({ id, rerankScore }) => ({ id, rerankScore })),
    );
    assert.deepEqual(
      ranked.map((candidate) => candidate.id).sort(),
      fused.map((candidate) => candidate.id).sort(),
      "ranking must only reorder the already eligible set",
    );
    assert.deepEqual(
      Object.keys(ranked[0]?.features ?? {}).sort(),
      [...DEFAULT_RANKING_POLICY.rerankFeatureNames].sort(),
    );
  });

  it("keeps conflict alternatives together across diversity and marks an opaque cursor on budget truncation", () => {
    const conflictMembers = ["A", "B", "C"].map((id, index) => ({
      id: `canonical:${id}`,
      rank: index + 1,
      channel: "exact" as const,
      item: item(id, {
        status: "conflicted",
        normalizedKey: "decision:conflict-set",
      }),
      conflictGroupId: "decision:conflict-set",
      highImpact: true,
      sourceKey: "shared-source",
      entityKey: "shared-entity",
      estimatedTokens: 6,
    }));
    const lowerPriority = {
      id: "canonical:later",
      rank: 4,
      channel: "exact" as const,
      item: item("later"),
      sourceKey: "other-source",
      entityKey: "other-entity",
      estimatedTokens: 1,
    };
    const ranked = rerankCandidates(
      fuseCandidates([[...conflictMembers, lowerPriority]], DEFAULT_RANKING_POLICY),
      REQUEST,
      DEFAULT_RANKING_POLICY,
    );

    const complete = selectRankedCandidates(ranked, {
      limit: 10,
      tokenBudget: 30,
    }, DEFAULT_RANKING_POLICY);
    assert.deepEqual(
      complete.candidates.slice(0, 3).map((candidate) => candidate.id),
      ["canonical:A", "canonical:B", "canonical:C"],
      "conflict closure bypasses ordinary source/entity diversity",
    );
    assert.equal(complete.conflicts[0]?.truncated, false);

    const bounded = selectRankedCandidates(ranked, {
      limit: 10,
      tokenBudget: 11,
    }, DEFAULT_RANKING_POLICY);
    assert.deepEqual(bounded.candidates.map((candidate) => candidate.id), ["canonical:A"]);
    assert.deepEqual(bounded.conflicts.map((conflict) => ({
      totalMemberCount: conflict.totalMemberCount,
      selectedMemberCount: conflict.selectedMemberCount,
      truncated: conflict.truncated,
      hasCursor: conflict.cursor !== null,
    })), [{
      totalMemberCount: 3,
      selectedMemberCount: 1,
      truncated: true,
      hasCursor: true,
    }]);
    assert.equal(bounded.conflicts[0]?.cursor?.includes("decision:conflict-set"), false);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.droppedByReason.tokenBudget, 2);
    assert.equal(bounded.droppedByReason.conflictSuppressed, 1);
    assert.equal(
      Object.values(bounded.droppedByReason).reduce((total, count) => total + count, 0),
      ranked.length - bounded.candidates.length,
    );
  });
});
