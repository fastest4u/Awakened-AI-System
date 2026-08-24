import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
import {
  RETRIEVAL_EVALUATION_CRITICAL_CLASSES,
  evaluateRetrieval,
  parseRetrievalEvaluationCorpus,
  type RetrievalEvaluationCorpusV1,
  type RetrievalEvaluationQueryV1,
} from "../src/orchestrator/retrieval/evaluation.js";
import type {
  InternalRetrievalRequest,
  ProjectionLeaseProvider,
  RetrievalCandidateCollection,
  RetrievalCandidateRepository,
  RetrievalChannel,
  RetrievalItem,
  RetrievalItemKind,
} from "../src/orchestrator/retrieval/contracts.js";
import { InternalRetrievalService } from "../src/orchestrator/retrieval/service.js";

const FIXTURE_URL = new URL(
  "../../tests/fixtures/retrieval-evaluation/v1/corpus.json",
  import.meta.url,
);
const EXPECTED_CANONICAL_SHA256 = "963020e36f6860522b545c749024db0672e87fb703ab762b5c53fa3d62402f99";

function readCorpus(): RetrievalEvaluationCorpusV1 {
  return parseRetrievalEvaluationCorpus(
    JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as unknown,
  );
}

function manifest(binding: ProjectBinding): ProjectionManifestV1 {
  return Object.freeze({
    schemaVersion: 1,
    projectId: binding.projectId,
    vaultId: binding.vaultId,
    storeId: binding.storeId,
    workspaceId: binding.workspaceId,
    branchScopeId: binding.branchScopeId,
    branchRef: binding.branchRef,
    sessionId: null,
    generation: 1,
    terminalEventPosition: "5000",
    terminalEventHash: "a".repeat(64),
    databaseFile: "projections-1-1.sqlite",
    databaseSha256: "b".repeat(64),
    coreChecksums: Object.freeze({
      sessionTree: "c".repeat(64),
      canonicalItems: "d".repeat(64),
      tasksFollowups: "e".repeat(64),
      artifactsFiles: "f".repeat(64),
      entityGraph: "1".repeat(64),
      lexicalChunks: "2".repeat(64),
      retrievalFeedback: "3".repeat(64),
    }),
    createdAt: "2026-08-24T00:00:00.000Z",
  });
}

function channelFor(query: RetrievalEvaluationQueryV1): RetrievalChannel {
  switch (query.criticalClass) {
    case "identifiers": return "exact";
    case "code-artifacts": return "symbol-path";
    case "session-continuity": return "session-checkpoint";
    case "follow-ups": return "open-follow-up";
    case "conflicts": return "conflict-closure";
    default: return "lexical";
  }
}

function kindFor(query: RetrievalEvaluationQueryV1): RetrievalItemKind {
  if (query.criticalClass === "code-artifacts") return "artifact";
  if (query.criticalClass === "session-continuity") return "checkpoint";
  if (query.criticalClass === "follow-ups") return "follow-up";
  return "canonical";
}

function itemFor(query: RetrievalEvaluationQueryV1): RetrievalItem {
  const [itemId] = Object.keys(query.relevanceGrades);
  const [citation] = query.expectedCitations;
  assert.ok(itemId);
  assert.ok(citation);
  const scope = query.eligibleScope;
  return Object.freeze({
    id: itemId,
    kind: kindFor(query),
    projectId: scope.projectId as ProjectId,
    workspaceId: scope.workspaceId as WorkspaceId,
    branchScopeId: scope.branchScopeId as BranchScopeId,
    branchRef: scope.branchRef,
    sessionId: scope.sessionId,
    visibility: scope.visibility,
    status: "verified",
    confidence: "high",
    verificationMethod: "adjudicated-synthetic-fixture",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    knownFromEventPosition: 1n,
    sourceEventPosition: 1n,
    summary: `synthetic evaluation item ${query.queryId}`,
    normalizedKey: query.queryId,
    anchor: citation.anchor,
    freshness: "fresh",
    conflictGroupId: query.expectations.conflictGroupIds[0] ?? null,
    supersedingItemId: null,
    retrievalFeedbackScoreUnits: 0,
  });
}

function createEvaluationService(
  corpus: RetrievalEvaluationCorpusV1,
  omitEvery = Number.POSITIVE_INFINITY,
  duplicateResults = false,
): Readonly<{ service: InternalRetrievalService; closed: () => number }> {
  const byText = new Map(corpus.queries.map((query) => [
    query.queryText.normalize("NFKC").trim(),
    query,
  ]));
  const first = corpus.queries[0];
  assert.ok(first);
  const binding: ProjectBinding = Object.freeze({
    projectId: first.eligibleScope.projectId as ProjectId,
    vaultId: first.eligibleScope.vaultId as VaultId,
    storeId: first.eligibleScope.storeId as StoreId,
    workspaceId: first.eligibleScope.workspaceId as WorkspaceId,
    branchScopeId: first.eligibleScope.branchScopeId as BranchScopeId,
    branchRef: first.eligibleScope.branchRef,
    sessionId: null,
  });
  const published = manifest(binding);
  let closed = 0;
  const projections: ProjectionLeaseProvider = {
    async pin(): Promise<ProjectionReaderLease> {
      return Object.freeze({
        manifest: published,
        databasePath: "synthetic-evaluation.sqlite",
        close() { closed += 1; },
      });
    },
  };
  const candidates: RetrievalCandidateRepository = {
    collectEligible(_lease, request): RetrievalCandidateCollection {
      const query = byText.get(request.query);
      assert.ok(query, "evaluation request must come from the committed corpus");
      const ordinal = Number(query.queryId.slice(-4));
      const omitted = Number.isFinite(omitEvery) && ordinal % omitEvery === 0;
      const item = itemFor(query);
      const duplicateItem: RetrievalItem = Object.freeze({
        ...item,
        kind: item.kind === "canonical" ? "lexical" : "canonical",
      });
      const channel = channelFor(query);
      const conflictGroupId = item.conflictGroupId;
      const rankedItems = omitted ? [] : duplicateResults ? [item, duplicateItem] : [item];
      return Object.freeze({
        channels: Object.freeze([Object.freeze({
          channel,
          candidates: Object.freeze(rankedItems.map((rankedItem, index) => Object.freeze({
            candidateId: `candidate:${rankedItem.kind}:${rankedItem.id}`,
            channel,
            rank: index + 1,
            item: rankedItem,
          }))),
        })]),
        eligibleItemCount: rankedItems.length,
        droppedItemCount: 0,
        truncated: false,
        conflictGroups: Object.freeze(conflictGroupId === null || omitted ? [] : [Object.freeze({
          conflictGroupId,
          eligibleMemberCount: 1,
          returnedMemberCount: 1,
          truncated: false,
          cursor: null,
        })]),
      });
    },
  };
  return Object.freeze({
    service: new InternalRetrievalService({ projections, candidates }),
    closed: () => closed,
  });
}

describe("immutable bilingual retrieval evaluation corpus", () => {
  it("contains exactly 500 deterministic, synthetic, independently judged cases", () => {
    const corpus = readCorpus();

    assert.equal(corpus.schemaVersion, 1);
    assert.equal(corpus.corpusVersion, "retrieval-evaluation-v1");
    assert.equal(corpus.fixtureSeed, "awakened-ai-retrieval-evaluation-v1-fixed-seed");
    assert.equal(corpus.evidencePolicy, "synthetic-identifiers-only");
    assert.equal(corpus.queries.length, 500);
    assert.deepEqual(
      new Set(corpus.queries.map((query) => query.language)),
      new Set(["en", "th", "mixed"]),
    );
    for (const criticalClass of RETRIEVAL_EVALUATION_CRITICAL_CLASSES) {
      const classQueries = corpus.queries.filter((query) => query.criticalClass === criticalClass);
      assert.ok(
        classQueries.length >= 50,
        `${criticalClass} needs at least 50 cases`,
      );
      assert.deepEqual(
        new Set(classQueries.map((query) => query.language)),
        new Set(["en", "th", "mixed"]),
        `${criticalClass} must independently cover English, Thai, and mixed queries`,
      );
    }
    for (const [index, query] of corpus.queries.entries()) {
      assert.equal(query.queryId, `eval-v1-${String(index + 1).padStart(4, "0")}`);
      assert.equal(query.queryText.normalize("NFKC"), query.queryText);
      assert.equal(query.judgments.length, 2);
      assert.equal(new Set(query.judgments.map((judgment) => judgment.judgeId)).size, 2);
      assert.deepEqual(query.judgments[0]?.relevanceGrades, query.relevanceGrades);
      assert.deepEqual(query.judgments[1]?.relevanceGrades, query.relevanceGrades);
      assert.ok(query.expectedCitations.length > 0);
      assert.ok(query.expectedCitations.every((citation) => (
        (query.relevanceGrades[citation.itemId] ?? 0) > 0
      )));
      assert.equal(Object.isFrozen(query), true);
      assert.equal(Object.isFrozen(query.eligibleScope), true);
    }
    const serialized = JSON.stringify(corpus);
    assert.equal(createHash("sha256").update(serialized).digest("hex"), EXPECTED_CANONICAL_SHA256);
    assert.doesNotMatch(serialized, /raw[-_ ]?evidence|authorization|credential|bearer\s|private[-_ ]?key/i);
    assert.match(serialized, /ADR-EVAL-/);
    assert.match(serialized, /sha256:[0-9a-f]{64}/);
    assert.match(serialized, /MISTAKE-EVAL-/);
    assert.match(serialized, /TASK-EVAL-/);
    assert.match(serialized, /src\/evaluation\/module-[0-9]{4}\.ts#handler[0-9]{4}/);
    assert.ok(corpus.queries.filter((query) => query.expectations.openFollowUp).length >= 50);
    assert.ok(corpus.queries.filter((query) => query.expectations.nextAction).length >= 50);
    for (const criticalClass of [
      "stale-superseded-facts",
      "cross-project-near-duplicates",
    ] as const) {
      assert.ok(corpus.queries
        .filter((query) => query.criticalClass === criticalClass)
        .every((query) => Object.values(query.relevanceGrades).includes(0)));
    }
  });

  it("rejects count, unknown-field, and adjudicated-citation mutations", () => {
    const source = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as Record<string, unknown>;
    const queries = source.queries as Array<Record<string, unknown>>;
    assert.throws(
      () => parseRetrievalEvaluationCorpus({ ...source, queries: queries.slice(1) }),
      /RETRIEVAL_EVALUATION_CORPUS_INVALID/,
    );
    assert.throws(
      () => parseRetrievalEvaluationCorpus({
        ...source,
        queries: [{ ...queries[0], rawEvidence: "must never enter the corpus" }, ...queries.slice(1)],
      }),
      /RETRIEVAL_EVALUATION_CORPUS_INVALID/,
    );
    assert.throws(
      () => parseRetrievalEvaluationCorpus({
        ...source,
        queries: [{
          ...queries[0],
          relevanceGrades: { "00000000-0000-4000-8000-000000000000": 0 },
        }, ...queries.slice(1)],
      }),
      /RETRIEVAL_EVALUATION_CORPUS_INVALID/,
    );
    const firstGrades = queries[0]?.relevanceGrades as Record<string, number>;
    const [firstItemId] = Object.keys(firstGrades);
    assert.ok(firstItemId);
    const accessorGrades: Record<string, number> = {};
    Object.defineProperty(accessorGrades, firstItemId, {
      enumerable: true,
      get() { throw new Error("accessor must not execute"); },
    });
    assert.throws(
      () => parseRetrievalEvaluationCorpus({
        ...source,
        queries: [{ ...queries[0], relevanceGrades: accessorGrades }, ...queries.slice(1)],
      }),
      /RETRIEVAL_EVALUATION_CORPUS_INVALID/,
    );
  });
});

describe("retrieval evaluation metrics", () => {
  it("meets every Subproject 3 threshold on the committed 500-query corpus", async () => {
    const corpus = readCorpus();
    const fixture = createEvaluationService(corpus);

    const report = await evaluateRetrieval(corpus, fixture.service);

    assert.equal(report.queryCount, 500);
    assert.equal(report.failedQueryCount, 0);
    assert.equal(report.crossProjectContamination, 0);
    assert.ok(report.recallAt10 >= 0.95);
    assert.ok(report.mrr >= 0.90);
    assert.ok(report.ndcgAt10 >= 0.90);
    assert.ok(report.citationPrecision >= 0.95);
    assert.ok(report.citationRecall >= 0.95);
    assert.ok(report.staleActiveMemoryRate <= 0.01);
    assert.equal(report.exactIdentifierPathRecall, 1);
    assert.equal(report.currentSessionCheckpointRecallAt10, 1);
    assert.equal(report.openFollowUpRecallAt10, 1);
    assert.equal(report.nextActionRecallAt10, 1);
    assert.ok(report.semanticParaphraseRecallAt10 >= 0.90);
    assert.ok(report.bitemporalAccuracy >= 0.95);
    assert.equal(report.conflictRecall, 1);
    assert.equal(report.conflictPrecision, 1);
    assert.equal(fixture.closed(), 500);
    assert.equal(Object.isFrozen(report), true);
    const aggregateOnly = JSON.stringify(report);
    assert.doesNotMatch(aggregateOnly, /queryText|expectedCitations|relevanceGrades|projectId/);
    if (process.env.RETRIEVAL_EVALUATION_REPORT === "1") process.stdout.write(`${aggregateOnly}\n`);
  });

  it("computes macro ranking metrics instead of merely counting queries", async () => {
    const corpus = readCorpus();
    const fixture = createEvaluationService(corpus, 20);

    const report = await evaluateRetrieval(corpus, fixture.service);

    assert.equal(report.recallAt10, 0.95);
    assert.equal(report.mrr, 0.95);
    assert.equal(report.ndcgAt10, 0.95);
    assert.equal(report.citationRecall, 0.95);
    assert.equal(report.citationPrecision, 1);
    assert.equal(fixture.closed(), 500);
  });

  it("bounds identifier-based metrics when two result kinds share one judged identifier", async () => {
    const corpus = readCorpus();
    const fixture = createEvaluationService(corpus, Number.POSITIVE_INFINITY, true);

    const report = await evaluateRetrieval(corpus, fixture.service);

    assert.equal(report.recallAt10, 1);
    assert.equal(report.ndcgAt10, 1);
    assert.equal(report.citationRecall, 1);
    assert.equal(report.citationPrecision, 1);
    assert.equal(fixture.closed(), 500);
  });

  it("counts cross-project contamination before collapsing duplicate identifiers", async () => {
    const corpus = readCorpus();
    const fixture = createEvaluationService(corpus);
    const [contaminatedQuery] = corpus.queries;
    assert.ok(contaminatedQuery);
    const contaminatedService = Object.freeze({
      async retrieve(request: InternalRetrievalRequest) {
        const result = await fixture.service.retrieve(request);
        if (request.query !== contaminatedQuery.queryText) return result;
        const [eligibleItem] = result.items;
        assert.ok(eligibleItem);
        const crossProjectDuplicate = Object.freeze({
          ...eligibleItem,
          projectId: "9".repeat(64) as ProjectId,
        });
        return Object.freeze({
          ...result,
          items: Object.freeze([eligibleItem, crossProjectDuplicate]),
        });
      },
    });

    const report = await evaluateRetrieval(corpus, contaminatedService);

    assert.equal(report.crossProjectContamination, 1);
    assert.equal(report.recallAt10, 1);
    assert.equal(report.ndcgAt10, 1);
    assert.equal(fixture.closed(), 500);
  });
});
