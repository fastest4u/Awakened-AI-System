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
  RetrievalEvaluationCorpusError,
  evaluateRetrieval,
  parseRetrievalEvaluationCorpus,
  parseSealedRetrievalEvaluationBundle,
  type RetrievalEvaluationCorpusV1,
  type RetrievalEvaluationQueryV1,
  type SealedRetrievalEvaluationCorpusV2,
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

type UnknownRecord = Record<string, unknown>;

interface SealedV2Inputs {
  readonly manifest: UnknownRecord;
  readonly sourceEvents: UnknownRecord;
  readonly judgments: UnknownRecord;
  readonly baseline: UnknownRecord;
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function sealV2Artifacts(
  sourceEvents: UnknownRecord,
  judgments: UnknownRecord,
  baseline: UnknownRecord,
): SealedV2Inputs {
  return {
    manifest: {
      schemaVersion: 2,
      corpusVersion: "retrieval-evaluation-v2",
      files: {
        "source-events.json": canonicalSha256(sourceEvents),
        "judgments.json": canonicalSha256(judgments),
        "v1-shadow-baseline.json": canonicalSha256(baseline),
      },
    },
    sourceEvents,
    judgments,
    baseline,
  };
}

function createValidSealedV2Inputs(): SealedV2Inputs {
  const projectId = "a".repeat(64);
  const vaultId = "b".repeat(64);
  const storeId = "c".repeat(64);
  const workspaceId = "d".repeat(64);
  const itemId = "10000000-0000-4000-8000-000000000001";
  const binding = {
    projectId,
    vaultId,
    storeId,
    workspaceId,
    branchScopeId: null,
    branchRef: null,
    sessionId: null,
  };
  const sourceEvents = {
    schemaVersion: 2,
    corpusVersion: "retrieval-evaluation-v2",
    sources: [{
      binding,
      events: [{
        globalPosition: "1",
        eventId: "20000000-0000-4000-8000-000000000001",
        idempotencyKey: "eval-source-command-0001",
        eventType: "MemorySourceRecorded",
        payload: {
          itemId,
          summary: "Synthetic source for strict bundle parsing",
        },
      }],
    }],
  };
  const relevanceGrades = { [itemId]: 3 };
  const query = {
    queryId: "eval-v2-0001",
    language: "en",
    criticalClass: "identifiers",
    queryText: "Find synthetic identifier ADR-EVAL-0001",
    eligibleScope: {
      projectId,
      vaultId,
      storeId,
      workspaceId,
      branchScopeId: null,
      branchRef: null,
      sessionId: null,
      visibility: "project",
      validAt: null,
      knownAt: null,
      requiredEventPosition: "1",
      deadlineMs: 1_000,
    },
    expectedCitations: [{ itemId, anchor: "memory://synthetic/item-0001" }],
    judgments: [
      { judgeId: "judge-a", relevanceGrades },
      { judgeId: "judge-b", relevanceGrades },
    ],
    relevanceGrades,
    expectations: {
      exactIdentifierPath: true,
      currentSessionCheckpoint: false,
      openFollowUp: false,
      nextAction: false,
      semanticParaphrase: false,
      bitemporal: false,
      conflictGroupIds: [],
    },
  };
  const judgments = {
    schemaVersion: 2,
    corpusVersion: "retrieval-evaluation-v2",
    queries: [query],
  };
  const baseline = {
    schemaVersion: 1,
    v1Version: "retrieval-evaluation-v1-shadow-test",
    judgmentsSha256: canonicalSha256(judgments.queries),
    metrics: {
      corpusVersion: "retrieval-evaluation-v1",
      queryCount: 1,
      failedQueryCount: 0,
      languageCounts: { en: 1, th: 0, mixed: 0 },
      criticalClassCounts: {
        identifiers: 1,
        "code-artifacts": 0,
        "session-continuity": 0,
        "follow-ups": 0,
        "stale-superseded-facts": 0,
        conflicts: 0,
        "cross-project-near-duplicates": 0,
        "semantic-paraphrases": 0,
        "temporal-boundaries": 0,
      },
      crossProjectContamination: 0,
      recallAt10: 1,
      mrr: 1,
      ndcgAt10: 1,
      citationPrecision: 1,
      citationRecall: 1,
      staleActiveMemoryRate: 0,
      exactIdentifierPathRecall: 1,
      currentSessionCheckpointRecallAt10: 0,
      openFollowUpRecallAt10: 0,
      nextActionRecallAt10: 0,
      semanticParaphraseRecallAt10: 0,
      bitemporalAccuracy: 0,
      conflictRecall: 0,
      conflictPrecision: 0,
      unsupportedHighImpactVerifiedClaims: 0,
    },
    provenanceCommand: "npm run test:retrieval-evaluation",
  };
  return sealV2Artifacts(sourceEvents, judgments, baseline);
}

function parseSealedInputs(inputs: SealedV2Inputs): SealedRetrievalEvaluationCorpusV2 {
  return parseSealedRetrievalEvaluationBundle(
    inputs.manifest,
    inputs.sourceEvents,
    inputs.judgments,
    inputs.baseline,
  );
}

function assertCorpusInvalid(action: () => unknown): void {
  assert.throws(action, (error: unknown) => (
    error instanceof RetrievalEvaluationCorpusError
    && error.message === "RETRIEVAL_EVALUATION_CORPUS_INVALID"
    && error.name === "RetrievalEvaluationCorpusError"
  ));
}

function withSecondQuery(
  inputs: SealedV2Inputs,
  secondOverrides: Readonly<Record<string, unknown>>,
): SealedV2Inputs {
  const first = (inputs.judgments.queries as UnknownRecord[])[0];
  assert.ok(first);
  const second = {
    ...first,
    queryId: "eval-v2-0002",
    queryText: "Find a second synthetic identifier ADR-EVAL-0002",
    ...secondOverrides,
  };
  const queries = [first, second];
  const judgments = { ...inputs.judgments, queries };
  const metrics = inputs.baseline.metrics as UnknownRecord;
  const criticalClassCounts = metrics.criticalClassCounts as UnknownRecord;
  const baseline = {
    ...inputs.baseline,
    judgmentsSha256: canonicalSha256(queries),
    metrics: {
      ...metrics,
      queryCount: 2,
      languageCounts: { en: 2, th: 0, mixed: 0 },
      criticalClassCounts: { ...criticalClassCounts, identifiers: 2 },
    },
  };
  return sealV2Artifacts(inputs.sourceEvents, judgments, baseline);
}

describe("sealed V2 retrieval evaluation bundle", () => {
  it("accepts a canonical bundle and returns defensive deep-frozen plain data", () => {
    const inputs = createValidSealedV2Inputs();

    const corpus = parseSealedInputs(inputs);

    assert.equal(corpus.bundle.schemaVersion, 2);
    assert.equal(corpus.bundle.corpusVersion, "retrieval-evaluation-v2");
    assert.equal(corpus.sources.length, 1);
    assert.equal(corpus.sources[0]?.events.length, 1);
    assert.equal(corpus.queries.length, 1);
    assert.equal(corpus.queries[0]?.queryId, "eval-v2-0001");
    assert.equal(corpus.baseline.judgmentsSha256, canonicalSha256(corpus.queries));
    assert.equal(corpus.baseline.metrics.corpusVersion, "retrieval-evaluation-v1");
    assert.notEqual(corpus.bundle, inputs.manifest);
    assert.notEqual(corpus.sources, inputs.sourceEvents.sources);
    assert.equal(Object.isFrozen(corpus), true);
    assert.equal(Object.isFrozen(corpus.bundle), true);
    assert.equal(Object.isFrozen(corpus.bundle.files), true);
    assert.equal(Object.isFrozen(corpus.sources), true);
    assert.equal(Object.isFrozen(corpus.sources[0]), true);
    assert.equal(Object.isFrozen(corpus.sources[0]?.binding), true);
    assert.equal(Object.isFrozen(corpus.sources[0]?.events), true);
    assert.equal(Object.isFrozen(corpus.sources[0]?.events[0]), true);
    assert.equal(Object.isFrozen(corpus.queries), true);
    assert.equal(Object.isFrozen(corpus.baseline), true);
    assert.equal(Object.isFrozen(corpus.baseline.metrics), true);
    assert.equal(Object.isFrozen(corpus.baseline.metrics.languageCounts), true);
  });

  it("rejects structurally valid source, judgments, baseline, and manifest hash tampering", () => {
    const inputs = createValidSealedV2Inputs();
    const sources = inputs.sourceEvents.sources as UnknownRecord[];
    const primary = sources[0];
    assert.ok(primary);
    const events = primary.events as UnknownRecord[];
    const firstEvent = events[0];
    assert.ok(firstEvent);
    const payload = firstEvent.payload as UnknownRecord;
    const changedSourceEvents = {
      ...inputs.sourceEvents,
      sources: [{
        ...primary,
        events: [{
          ...firstEvent,
          payload: { ...payload, summary: "Changed but structurally valid synthetic source" },
        }],
      }],
    };
    const queries = inputs.judgments.queries as UnknownRecord[];
    const firstQuery = queries[0];
    assert.ok(firstQuery);
    const changedJudgments = {
      ...inputs.judgments,
      queries: [{
        ...firstQuery,
        eligibleScope: {
          ...(firstQuery.eligibleScope as UnknownRecord),
          deadlineMs: 2_000,
        },
      }],
    };
    const changedBaseline = {
      ...inputs.baseline,
      v1Version: "retrieval-evaluation-v1-shadow-changed",
    };
    const files = inputs.manifest.files as UnknownRecord;
    const changedManifest = {
      ...inputs.manifest,
      files: { ...files, "source-events.json": "0".repeat(64) },
    };
    const mutations = [
      [inputs.manifest, changedSourceEvents, inputs.judgments, inputs.baseline],
      [inputs.manifest, inputs.sourceEvents, changedJudgments, inputs.baseline],
      [inputs.manifest, inputs.sourceEvents, inputs.judgments, changedBaseline],
      [changedManifest, inputs.sourceEvents, inputs.judgments, inputs.baseline],
    ] as const;

    for (const [manifestValue, sourceValue, judgmentsValue, baselineValue] of mutations) {
      assertCorpusInvalid(() => parseSealedRetrievalEvaluationBundle(
        manifestValue,
        sourceValue,
        judgmentsValue,
        baselineValue,
      ));
    }
  });

  it("rejects unknown, accessor, inherited, symbolic, and non-enumerable data without invoking accessors", () => {
    const inputs = createValidSealedV2Inputs();
    assertCorpusInvalid(() => parseSealedRetrievalEvaluationBundle(
      { ...inputs.manifest, unexpected: true },
      inputs.sourceEvents,
      inputs.judgments,
      inputs.baseline,
    ));

    let accessorInvoked = false;
    const accessorManifest = { ...inputs.manifest };
    Object.defineProperty(accessorManifest, "files", {
      enumerable: true,
      get() {
        accessorInvoked = true;
        return inputs.manifest.files;
      },
    });
    assertCorpusInvalid(() => parseSealedRetrievalEvaluationBundle(
      accessorManifest,
      inputs.sourceEvents,
      inputs.judgments,
      inputs.baseline,
    ));
    assert.equal(accessorInvoked, false);

    const sources = inputs.sourceEvents.sources as UnknownRecord[];
    const primary = sources[0];
    assert.ok(primary);
    const firstEvent = (primary.events as UnknownRecord[])[0];
    assert.ok(firstEvent);

    const accessorEvent = { ...firstEvent };
    delete accessorEvent.eventId;
    Object.defineProperty(accessorEvent, "eventId", {
      enumerable: true,
      get() {
        accessorInvoked = true;
        return firstEvent.eventId;
      },
    });
    const accessorSource = {
      ...inputs.sourceEvents,
      sources: [{ ...primary, events: [accessorEvent] }],
    };
    assertCorpusInvalid(() => parseSealedRetrievalEvaluationBundle(
      inputs.manifest,
      accessorSource,
      inputs.judgments,
      inputs.baseline,
    ));
    assert.equal(accessorInvoked, false);

    const inheritedEvent = Object.assign(
      Object.create({ inherited: true }) as UnknownRecord,
      firstEvent,
    );
    const inheritedSource = {
      ...inputs.sourceEvents,
      sources: [{ ...primary, events: [inheritedEvent] }],
    };
    assertCorpusInvalid(() => parseSealedRetrievalEvaluationBundle(
      inputs.manifest,
      inheritedSource,
      inputs.judgments,
      inputs.baseline,
    ));

    const symbolEvent = { ...firstEvent };
    Object.defineProperty(symbolEvent, Symbol("hidden"), { enumerable: true, value: "hidden" });
    const symbolSource = {
      ...inputs.sourceEvents,
      sources: [{ ...primary, events: [symbolEvent] }],
    };
    assertCorpusInvalid(() => parseSealedRetrievalEvaluationBundle(
      inputs.manifest,
      symbolSource,
      inputs.judgments,
      inputs.baseline,
    ));

    const nonEnumerableEvent = { ...firstEvent };
    Object.defineProperty(nonEnumerableEvent, "hidden", { enumerable: false, value: "hidden" });
    const nonEnumerableSource = {
      ...inputs.sourceEvents,
      sources: [{ ...primary, events: [nonEnumerableEvent] }],
    };
    assertCorpusInvalid(() => parseSealedRetrievalEvaluationBundle(
      inputs.manifest,
      nonEnumerableSource,
      inputs.judgments,
      inputs.baseline,
    ));
  });

  it("rejects NFKC-unstable, malformed-hash, and credential-bearing data", () => {
    const inputs = createValidSealedV2Inputs();
    const sources = inputs.sourceEvents.sources as UnknownRecord[];
    const primary = sources[0];
    assert.ok(primary);
    const firstEvent = (primary.events as UnknownRecord[])[0];
    assert.ok(firstEvent);
    const payload = firstEvent.payload as UnknownRecord;
    for (const summary of ["ＮＦＫＣ unstable", "Bearer synthetic-secret"]) {
      const changedSource = {
        ...inputs.sourceEvents,
        sources: [{
          ...primary,
          events: [{ ...firstEvent, payload: { ...payload, summary } }],
        }],
      };
      const resealed = sealV2Artifacts(changedSource, inputs.judgments, inputs.baseline);
      assertCorpusInvalid(() => parseSealedInputs(resealed));
    }

    const files = inputs.manifest.files as UnknownRecord;
    assertCorpusInvalid(() => parseSealedRetrievalEvaluationBundle(
      {
        ...inputs.manifest,
        files: { ...files, "judgments.json": "not-a-lowercase-sha256" },
      },
      inputs.sourceEvents,
      inputs.judgments,
      inputs.baseline,
    ));
  });

  it("rejects duplicate source bindings, event IDs, and idempotency keys across the bundle", () => {
    const inputs = createValidSealedV2Inputs();
    const sources = inputs.sourceEvents.sources as UnknownRecord[];
    const primary = sources[0];
    assert.ok(primary);
    const firstEvent = (primary.events as UnknownRecord[])[0];
    assert.ok(firstEvent);

    const duplicateCases = [
      { ...firstEvent, idempotencyKey: "eval-source-command-0002" },
      {
        ...firstEvent,
        eventId: "20000000-0000-4000-8000-000000000002",
      },
    ];
    for (const duplicate of duplicateCases) {
      const changedSource = {
        ...inputs.sourceEvents,
        sources: [{ ...primary, events: [firstEvent, duplicate] }],
      };
      const resealed = sealV2Artifacts(changedSource, inputs.judgments, inputs.baseline);
      assertCorpusInvalid(() => parseSealedInputs(resealed));
    }

    const distinctEvent = {
      ...firstEvent,
      eventId: "20000000-0000-4000-8000-000000000002",
      idempotencyKey: "eval-source-command-0002",
    };
    const duplicateBindingSource = {
      ...inputs.sourceEvents,
      sources: [primary, { ...primary, events: [distinctEvent] }],
    };
    const resealed = sealV2Artifacts(
      duplicateBindingSource,
      inputs.judgments,
      inputs.baseline,
    );
    assertCorpusInvalid(() => parseSealedInputs(resealed));
  });

  it("rejects duplicate query IDs and duplicate query text after all bundle hashes are resealed", () => {
    const inputs = createValidSealedV2Inputs();
    const first = (inputs.judgments.queries as UnknownRecord[])[0];
    assert.ok(first);
    const duplicateId = withSecondQuery(inputs, {
      queryId: first.queryId,
      queryText: "Find a unique second synthetic identifier",
    });
    const duplicateText = withSecondQuery(inputs, { queryText: first.queryText });

    assertCorpusInvalid(() => parseSealedInputs(duplicateId));
    assertCorpusInvalid(() => parseSealedInputs(duplicateText));
  });

  it("rejects a non-V1 or count-divergent frozen shadow baseline", () => {
    const inputs = createValidSealedV2Inputs();
    const metrics = inputs.baseline.metrics as UnknownRecord;
    for (const changedMetrics of [
      { ...metrics, corpusVersion: "retrieval-evaluation-v2" },
      { ...metrics, queryCount: 2 },
    ]) {
      const changedBaseline = { ...inputs.baseline, metrics: changedMetrics };
      const resealed = sealV2Artifacts(
        inputs.sourceEvents,
        inputs.judgments,
        changedBaseline,
      );
      assertCorpusInvalid(() => parseSealedInputs(resealed));
    }
  });

  it("rejects negative-zero metrics that compact JSON would collapse to zero", () => {
    const inputs = createValidSealedV2Inputs();
    const metrics = inputs.baseline.metrics as UnknownRecord;
    const changedBaseline = {
      ...inputs.baseline,
      metrics: { ...metrics, staleActiveMemoryRate: -0 },
    };
    const resealed = sealV2Artifacts(
      inputs.sourceEvents,
      inputs.judgments,
      changedBaseline,
    );

    assertCorpusInvalid(() => parseSealedInputs(resealed));
  });
});

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
