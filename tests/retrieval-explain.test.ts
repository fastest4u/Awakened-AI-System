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
import type { ProjectionManifestV1 } from "../src/orchestrator/projections/manifest.js";
import type { ProjectionReaderLease } from "../src/orchestrator/projections/reader-lease.js";
import type {
  InternalRetrievalRequest,
  RetrievalCandidateCollection,
  RetrievalItem,
} from "../src/orchestrator/retrieval/contracts.js";
import {
  buildRetrievalExplanation,
  type RankedRetrieval,
} from "../src/orchestrator/retrieval/explain.js";
import { DEFAULT_RANKING_POLICY } from "../src/orchestrator/retrieval/ranking.js";
import { InternalRetrievalService } from "../src/orchestrator/retrieval/service.js";

const PROJECT_ID = "1".repeat(64) as ProjectId;
const OTHER_PROJECT_ID = "9".repeat(64) as ProjectId;
const WORKSPACE_ID = "2".repeat(64) as WorkspaceId;
const BRANCH_SCOPE_ID = "00000000-0000-4000-8000-000000000611" as BranchScopeId;
const SESSION_ID = "00000000-0000-4000-8000-000000000612";

const BINDING: ProjectBinding = Object.freeze({
  projectId: PROJECT_ID,
  vaultId: "3".repeat(64) as VaultId,
  storeId: "4".repeat(64) as StoreId,
  workspaceId: WORKSPACE_ID,
  branchScopeId: BRANCH_SCOPE_ID,
  branchRef: "refs/heads/task-6",
  sessionId: null,
});

const MANIFEST: ProjectionManifestV1 = Object.freeze({
  schemaVersion: 1,
  projectId: BINDING.projectId,
  vaultId: BINDING.vaultId,
  storeId: BINDING.storeId,
  workspaceId: BINDING.workspaceId,
  branchScopeId: BINDING.branchScopeId,
  branchRef: BINDING.branchRef,
  sessionId: null,
  generation: 6,
  terminalEventPosition: "100",
  terminalEventHash: "a".repeat(64),
  databaseFile: "projections-1-6.sqlite",
  databaseSha256: "b".repeat(64),
  coreChecksums: Object.freeze({
    sessionTree: "c".repeat(64), canonicalItems: "d".repeat(64),
    tasksFollowups: "e".repeat(64), artifactsFiles: "f".repeat(64),
    entityGraph: "1".repeat(64), lexicalChunks: "2".repeat(64),
    retrievalFeedback: "3".repeat(64),
  }),
  createdAt: "2026-08-24T00:00:00.000Z",
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
    status: "conflicted",
    confidence: "high",
    verificationMethod: "committed-event",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    knownFromEventPosition: 10n,
    sourceEventPosition: 90n,
    summary: `capability-secret-${id}`,
    normalizedKey: "decision:conflict-set",
    anchor: null,
    freshness: "fresh",
    ...overrides,
  });
}

function request(overrides: Partial<InternalRetrievalRequest> = {}): InternalRetrievalRequest {
  return Object.freeze({
    binding: BINDING,
    query: "capability-secret",
    limit: 10,
    tokenBudget: 1_200,
    consistency: Object.freeze({ requiredEventPosition: 90n, deadlineMs: 100 }),
    sessionId: SESSION_ID,
    visibility: "session",
    explain: true,
    ...overrides,
  });
}

describe("redacted retrieval explanations", () => {
  it("accepts the aggregate-only ranked result contract from the plan", () => {
    const explanation = buildRetrievalExplanation({
      eligibleCount: 0,
      redactedDropCounts: { total: 0, byReason: {} },
      channelContributions: [],
      manifest: { generation: 1 },
      requiredEventPosition: 0n,
      publishedEventPosition: 0n,
    });

    assert.equal(explanation.ranking.policyVersion, DEFAULT_RANKING_POLICY.version);
    assert.deepEqual(
      explanation.ranking.rerankFeatureNames,
      DEFAULT_RANKING_POLICY.rerankFeatureNames,
    );
    assert.deepEqual(explanation.conflicts, {
      groupCount: 0,
      totalMemberCount: 0,
      truncated: false,
      cursorAvailable: false,
    });
  });

  it("rebuilds a bounded whitelist instead of reflecting secret-bearing result input", () => {
    const result = {
      eligibleCount: 2,
      redactedDropCounts: {
        total: 1,
        byReason: { scopeDenied: 1 },
        secret: "capability-secret",
      },
      channelContributions: [{
        channel: "exact" as const,
        eligibleCount: 2,
        selectedCount: 1,
        bestRank: 1,
        worstRank: 2,
        fusionContribution: 0.25,
        providerInput: "capability-secret",
      }],
      manifest: { generation: 6, capabilityHandle: "capability-secret" },
      requiredEventPosition: 90n,
      publishedEventPosition: 100n,
      rankingPolicyVersion: DEFAULT_RANKING_POLICY.version,
      rerankFeatureNames: [
        ...DEFAULT_RANKING_POLICY.rerankFeatureNames,
        "capability-secret",
      ],
      conflicts: {
        groupCount: 1,
        totalMemberCount: 2,
        truncated: true,
        cursor: "capability-secret",
      },
      truncated: true,
      candidateText: "capability-secret",
      providerInput: "capability-secret",
      rawEvidence: "capability-secret",
    } as unknown as RankedRetrieval;

    const explanation = buildRetrievalExplanation(result);
    const serialized = JSON.stringify(explanation);

    assert.equal(serialized.includes("capability-secret"), false);
    assert.equal(explanation.dropped.byReason.scopeDenied, 1);
    assert.deepEqual(explanation.channels, [{
      channel: "exact",
      eligibleCount: 2,
      selectedCount: 1,
      bestRank: 1,
      worstRank: 2,
      fusionContribution: 0.25,
    }]);
    assert.deepEqual(explanation.consistency, {
      projectionGeneration: 6,
      requiredEventPosition: "90",
      publishedEventPosition: "100",
    });
    assert.equal(explanation.conflicts.cursorAvailable, true);
    assert.equal(Object.isFrozen(explanation), true);
    assert.equal(Object.isFrozen(explanation.dropped.byReason), true);
    assert.ok(Buffer.byteLength(serialized, "utf8") < 65_536);
  });

  it("rechecks every conflict member independently before rank fusion and explains only redacted counts", async () => {
    let closed = 0;
    const lease: ProjectionReaderLease = Object.freeze({
      manifest: MANIFEST,
      databasePath: "unused-by-injected-repository.sqlite",
      close: () => { closed += 1; },
    });
    const eligibleA = item("eligible-a");
    const scopeDenied = item("scope-denied", { projectId: OTHER_PROJECT_ID });
    const eligibleB = item("eligible-b", { kind: "lexical" });
    const collection: RetrievalCandidateCollection = Object.freeze({
      channels: Object.freeze([Object.freeze({
        channel: "exact",
        candidates: Object.freeze([
          Object.freeze({ candidateId: "exact:a", channel: "exact", rank: 1, item: eligibleA }),
          Object.freeze({ candidateId: "exact:bad", channel: "exact", rank: 2, item: scopeDenied }),
          Object.freeze({ candidateId: "exact:b", channel: "exact", rank: 3, item: eligibleB }),
        ]),
      })]),
      eligibleItemCount: 3,
      droppedItemCount: 0,
      truncated: false,
    });
    const service = new InternalRetrievalService({
      projections: { async pin() { return lease; } },
      candidates: { collectEligible() { return collection; } },
    });

    const result = await service.retrieve(request());

    assert.deepEqual(result.items.map((candidate) => candidate.id), [
      "eligible-a",
      "eligible-b",
    ]);
    assert.equal(result.items.some((candidate) => candidate.projectId === OTHER_PROJECT_ID), false);
    assert.equal(result.conflicts[0]?.totalMemberCount, 2);
    assert.equal(result.conflicts[0]?.truncated, false);
    assert.equal(result.explanation?.dropped.byReason.scopeDenied, 1);
    assert.equal(JSON.stringify(result.explanation).includes("capability-secret"), false);
    assert.equal(closed, 1);
  });

  it("applies source diversity across representations of the same source event", async () => {
    const lease: ProjectionReaderLease = Object.freeze({
      manifest: MANIFEST,
      databasePath: "unused-by-injected-repository.sqlite",
      close: () => undefined,
    });
    const sameSource = [
      item("canonical-source", {
        kind: "canonical",
        status: "active",
        normalizedKey: "decision:canonical-source",
      }),
      item("lexical-source", {
        kind: "lexical",
        status: "active",
        normalizedKey: "decision:lexical-source",
      }),
      item("artifact-source", {
        kind: "artifact",
        status: "active",
        normalizedKey: "decision:artifact-source",
      }),
    ];
    const collection: RetrievalCandidateCollection = Object.freeze({
      channels: Object.freeze([Object.freeze({
        channel: "exact",
        candidates: Object.freeze(sameSource.map((candidate, index) => Object.freeze({
          candidateId: `exact:${candidate.id}`,
          channel: "exact" as const,
          rank: index + 1,
          item: candidate,
        }))),
      })]),
      eligibleItemCount: sameSource.length,
      droppedItemCount: 0,
      truncated: false,
    });
    const service = new InternalRetrievalService({
      projections: { async pin() { return lease; } },
      candidates: { collectEligible() { return collection; } },
    });

    const result = await service.retrieve(request());

    assert.equal(result.items.length, DEFAULT_RANKING_POLICY.diversity.maxPerSource);
    assert.equal(result.redactedDropCounts.byReason.diversity, 1);
    assert.equal(result.truncated, true);
  });

  it("omits an explanation that cannot fit its caller-provided byte bound", async () => {
    const lease: ProjectionReaderLease = Object.freeze({
      manifest: MANIFEST,
      databasePath: "unused-by-injected-repository.sqlite",
      close: () => undefined,
    });
    const service = new InternalRetrievalService({
      projections: { async pin() { return lease; } },
      candidates: {
        collectEligible(): RetrievalCandidateCollection {
          return Object.freeze({
            channels: Object.freeze([]),
            eligibleItemCount: 0,
            droppedItemCount: 0,
            truncated: false,
          });
        },
      },
    });

    const result = await service.retrieve(request({ explainByteLimit: 1 }));
    assert.equal(result.explanation, undefined);
    assert.equal(result.explanationTruncated, true);
  });
});
