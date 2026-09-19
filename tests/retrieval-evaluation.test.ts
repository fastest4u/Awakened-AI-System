import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createV2ShadowMigrationFixture } from "./support/v2-shadow-migration-fixture.js";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import type {
  BranchScopeId,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import { ImmutableProjectionBuilder } from "../src/orchestrator/projections/builder.js";
import {
  DefaultProjectionBuildCoordinator,
  V2ProjectionBuildCoordinator,
} from "../src/orchestrator/projections/coordinator.js";
import { SqliteProjectionEventReader } from "../src/orchestrator/projections/event-reader.js";
import type {
  ProjectionManifestV1,
  ProjectionManifestV2,
} from "../src/orchestrator/projections/manifest.js";
import type { ProjectionReaderLease } from "../src/orchestrator/projections/reader-lease.js";
import type { V2ProjectionReaderLease } from "../src/orchestrator/projections/v2-reader-lease.js";
import {
  RETRIEVAL_EVALUATION_CRITICAL_CLASSES,
  RetrievalEvaluationCorpusError,
  assertSealedEvaluationVectorDisabled,
  assertSealedRetrievalThresholds,
  evaluateRetrieval,
  evaluateRetrievalQueries,
  evaluateSealedRetrieval,
  parseRetrievalEvaluationCorpus,
  parseSealedRetrievalEvaluationBundle,
  type RetrievalEvaluationCorpusV1,
  type RetrievalEvaluationQueryV1,
  type RetrievalEvaluationReport,
  type SealedRetrievalEvaluationCorpusV2,
} from "../src/orchestrator/retrieval/evaluation.js";
import {
  eventHash as storedEventHash,
  payloadHash as storedPayloadHash,
} from "../src/orchestrator/crypto/event-hash.js";
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
import { SqliteRetrievalCandidateRepository } from "../src/orchestrator/retrieval/candidates.js";
import { V2SqliteRetrievalCandidateRepository } from "../src/orchestrator/retrieval/v2-candidates.js";
import { PROJECT_MEMORY_APPLICATION_ID } from "../src/orchestrator/runtime/runtime-capabilities.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { GENESIS_GLOBAL_HASH } from "../src/orchestrator/storage/event-store.js";
import { ShadowMigrationError } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import type { ShadowMigrationInvocationDeadline } from "../src/orchestrator/migration/v2-shadow-migration-runtime.js";

const FIXTURE_URL = new URL(
  "../../tests/fixtures/retrieval-evaluation/v1/corpus.json",
  import.meta.url,
);
const V2_SOURCE_EVENTS_FIXTURE_URL = new URL(
  "../../tests/fixtures/retrieval-evaluation/v2/source-events.json",
  import.meta.url,
);
const V2_JUDGMENTS_FIXTURE_URL = new URL(
  "../../tests/fixtures/retrieval-evaluation/v2/judgments.json",
  import.meta.url,
);
const V2_V1_SHADOW_BASELINE_FIXTURE_URL = new URL(
  "../../tests/fixtures/retrieval-evaluation/v2/v1-shadow-baseline.json",
  import.meta.url,
);
const V2_MANIFEST_FIXTURE_URL = new URL(
  "../../tests/fixtures/retrieval-evaluation/v2/manifest.json",
  import.meta.url,
);
const EXPECTED_CANONICAL_SHA256 = "963020e36f6860522b545c749024db0672e87fb703ab762b5c53fa3d62402f99";
const STORED_EVENT_ENVELOPE_KEYS = Object.freeze([
  "globalPosition", "eventId", "projectId", "vaultId", "storeId", "workspaceId",
  "branchScopeId", "branchRef", "streamId", "streamType", "streamVersion", "eventType",
  "eventSchemaVersion", "sessionId", "parentSessionId", "actorRole", "agentId",
  "clientInstanceId", "correlationId", "causationId", "commandId", "idempotencyKey",
  "commandEventIndex", "occurredAt", "recordedAt", "visibilityScope", "confidence",
  "verificationStatus", "sourceRefs", "evidenceRefs", "evidenceDigests", "payload",
  "payloadJson", "payloadHash", "previousGlobalHash", "eventHash", "lifecycleIntentJson",
] as const);
const ANSWER_DERIVED_FIELDS = new Set([
  "answer", "answers", "candidate", "candidates", "expectedResult", "expectedResults",
  "queryTextToItem", "queryTextToItemId", "queryTextToItemLookup",
]);

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  assert.equal(typeof value, "object", `${label} must be an object`);
  assert.notEqual(value, null, `${label} must be non-null`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array`);
  return value as UnknownRecord;
}

function rawStoredEventHashInput(event: UnknownRecord): UnknownRecord {
  return {
    globalPosition: event.globalPosition,
    eventId: event.eventId,
    projectId: event.projectId,
    vaultId: event.vaultId,
    storeId: event.storeId,
    workspaceId: event.workspaceId,
    branchScopeId: event.branchScopeId,
    branchRef: event.branchRef,
    streamId: event.streamId,
    streamType: event.streamType,
    streamVersion: event.streamVersion,
    eventType: event.eventType,
    eventSchemaVersion: event.eventSchemaVersion,
    sessionId: event.sessionId,
    parentSessionId: event.parentSessionId,
    actorRole: event.actorRole,
    agentId: event.agentId,
    clientInstanceId: event.clientInstanceId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    commandId: event.commandId,
    idempotencyKey: event.idempotencyKey,
    commandEventIndex: event.commandEventIndex,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    visibilityScope: event.visibilityScope,
    confidence: event.confidence,
    verificationStatus: event.verificationStatus,
    sourceRefs: event.sourceRefs,
    evidenceRefs: event.evidenceRefs,
    evidenceDigests: event.evidenceDigests,
    payloadHash: event.payloadHash,
    previousGlobalHash: event.previousGlobalHash,
  };
}

function assertNoAnswerDerivedFields(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) assertNoAnswerDerivedFields(entry, `${label}[${index}]`);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    assert.equal(ANSWER_DERIVED_FIELDS.has(key), false, `${label}.${key} is answer-derived`);
    assertNoAnswerDerivedFields(entry, `${label}.${key}`);
  }
}

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

describe("sealed corpus production identity boundary", () => {
  function withIdentity(value: string): SealedV2Inputs {
    const inputs = createValidSealedV2Inputs();
    const replace = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(replace);
      if (v === null || typeof v !== "object") return v;
      return Object.fromEntries(Object.entries(v).map(([k, entry]) => [k,
        ["projectId", "vaultId", "storeId"].includes(k) ? value : replace(entry)]));
    };
    const sources = replace(inputs.sourceEvents) as UnknownRecord;
    const judgments = replace(inputs.judgments) as UnknownRecord;
    const baseline = { ...inputs.baseline, judgmentsSha256: canonicalSha256(judgments.queries) };
    return sealV2Artifacts(sources, judgments, baseline);
  }
  it("seals production UUID identities while retaining the legacy corpus contract", () => {
    const uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const parsed = parseSealedInputs(withIdentity(uuid));
    assert.equal(parsed.sources[0]!.binding.projectId, uuid);
    assert.equal(parsed.queries[0]!.eligibleScope.storeId, uuid);
    assert.equal(parseSealedInputs(createValidSealedV2Inputs()).sources[0]!.binding.projectId, "a".repeat(64));
  });
  it("rejects malformed, uppercase, wrong-version and padded production identities", () => {
    for (const id of ["aaaaaaaa-bbbb-3ccc-8ddd-eeeeeeeeeeee", "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\0", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeeee", "a".repeat(63), " a".repeat(32)]) {
      assertCorpusInvalid(() => parseSealedInputs(withIdentity(id)));
    }
  });
});

describe("sealed corpus production witness boundary", () => {
  it("preserves real writer witness bytes and rejects unsafe strings or misplaced witness exceptions", async t => {
    const f = await createV2ShadowMigrationFixture(t, { parityCorpus: true, legacyArtifacts: false });
    const original = createValidSealedV2Inputs();
    const queries = (original.judgments.queries as UnknownRecord[]).map(query => ({ ...query,
      eligibleScope: { ...(query.eligibleScope as UnknownRecord), ...f.projectionBinding, sessionId: f.sourceEvents[0]!.sessionId,
        visibility: "session", requiredEventPosition: f.manifest.terminalEventPosition } }));
    const judgments = { ...original.judgments, queries };
    const baseline = { ...original.baseline, judgmentsSha256: canonicalSha256(queries) };
    const events = JSON.parse(JSON.stringify(f.sourceEvents, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)) as UnknownRecord[];
    const sources = { schemaVersion: 2, corpusVersion: "retrieval-evaluation-v2", sources: [{ binding: f.projectionBinding, events }] };
    const sealed = sealV2Artifacts(sources, judgments, baseline);
    const parsed = parseSealedInputs(sealed);
    const witness = events[0]!.lifecycleIntentJson;
    assert.equal(typeof witness, "string");
    assert.equal(parsed.sources[0]!.events[0]!.lifecycleIntentJson, witness);
    assert.equal(parsed.bundle.files["source-events.json"], canonicalSha256(sources));
    assert.deepEqual(Object.keys(parsed.sources[0]!.events[0]!), Object.keys(events[0]!));
    const altered = (edit: (event: UnknownRecord) => void) => {
      const next = structuredClone(sources); edit(next.sources[0]!.events[0]!);
      return sealV2Artifacts(next, judgments, baseline);
    };
    for (const bad of ["{", `${witness} `, "x".repeat(1_048_577), canonicalJson({ ...JSON.parse(String(witness)), extra: true }), JSON.parse(String(witness))]) {
      assertCorpusInvalid(() => parseSealedInputs(altered(event => { event.lifecycleIntentJson = bad; })));
    }
    for (const text of ["authorization user text", "credential secret", "pmcap1.bearer", "Ａ", "line\nbreak"]) {
      const changed = JSON.parse(String(witness)); changed.intent.command.continuityKey = text;
      assertCorpusInvalid(() => parseSealedInputs(altered(event => { event.lifecycleIntentJson = canonicalJson(changed); })));
    }
    assertCorpusInvalid(() => parseSealedInputs(altered(event => { event.extra = { lifecycleIntentJson: witness }; })));
    assertCorpusInvalid(() => parseSealedInputs(altered(event => { event.summary = witness; })));
    const accessor = structuredClone(sources);
    let reads = 0;
    Object.defineProperty(accessor.sources[0]!.events[0]!, "lifecycleIntentJson", { enumerable: true, get() { reads++; return witness; } });
    assertCorpusInvalid(() => parseSealedRetrievalEvaluationBundle(sealed.manifest, accessor, judgments, baseline));
    assert.equal(reads, 0);
  });
});

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

describe("static deterministic V2 retrieval evaluation fixtures", () => {
  it("materializes complete source chains and independently judged raw cases", () => {
    const sourceArtifact = record(
      JSON.parse(readFileSync(V2_SOURCE_EVENTS_FIXTURE_URL, "utf8")) as unknown,
      "source-events fixture",
    );
    const judgmentsArtifact = record(
      JSON.parse(readFileSync(V2_JUDGMENTS_FIXTURE_URL, "utf8")) as unknown,
      "judgments fixture",
    );

    assert.deepEqual(Object.keys(sourceArtifact), ["schemaVersion", "corpusVersion", "sources"]);
    assert.equal(sourceArtifact.schemaVersion, 2);
    assert.equal(sourceArtifact.corpusVersion, "retrieval-evaluation-v2");
    assert.deepEqual(Object.keys(judgmentsArtifact), ["schemaVersion", "corpusVersion", "queries"]);
    assert.equal(judgmentsArtifact.schemaVersion, 2);
    assert.equal(judgmentsArtifact.corpusVersion, "retrieval-evaluation-v2");

    const sources = sourceArtifact.sources;
    assert.ok(Array.isArray(sources));
    assert.equal(sources.length, 2);
    const primary = record(sources[0], "primary source");
    const competing = record(sources[1], "competing source");
    assert.deepEqual(Object.keys(primary), ["binding", "events"]);
    assert.deepEqual(Object.keys(competing), ["binding", "events"]);
    assert.notDeepEqual(primary.binding, competing.binding);

    const primaryEvents = primary.events;
    const competingEvents = competing.events;
    assert.ok(Array.isArray(primaryEvents));
    assert.ok(Array.isArray(competingEvents));
    assert.equal(primaryEvents.length, 504);
    assert.equal(competingEvents.length, 1);

    const primaryItemIds = new Set<string>();
    const primaryMemoryPayloads: UnknownRecord[] = [];
    for (const [sourceIndex, rawEvents] of [primaryEvents, competingEvents].entries()) {
      let previousHash = "0".repeat(64);
      for (const [eventIndex, rawEvent] of rawEvents.entries()) {
        const event = record(rawEvent, `sources[${sourceIndex}].events[${eventIndex}]`);
        assert.deepEqual(
          [...Object.keys(event)].sort(),
          [...STORED_EVENT_ENVELOPE_KEYS].sort(),
        );
        assert.equal(event.globalPosition, String(eventIndex + 1));
        assert.equal(event.streamVersion, String(eventIndex + 1));
        assert.equal(event.previousGlobalHash, previousHash);
        assert.equal(event.lifecycleIntentJson, null);
        if (typeof event.payloadJson !== "string") assert.fail("payloadJson must be a string");
        if (typeof event.payloadHash !== "string") assert.fail("payloadHash must be a string");
        if (typeof event.eventHash !== "string") assert.fail("eventHash must be a string");
        const parsedPayload = JSON.parse(event.payloadJson) as unknown;
        assert.deepEqual(parsedPayload, event.payload);
        assert.equal(canonicalJson(parsedPayload), event.payloadJson);
        assert.equal(storedPayloadHash(parsedPayload), event.payloadHash);
        assert.equal(storedEventHash(rawStoredEventHashInput(event)), event.eventHash);
        previousHash = event.eventHash;
      }
    }

    const firstPrimary = record(primaryEvents[0], "primary SessionStarted event");
    const secondPrimary = record(primaryEvents[1], "primary SessionCheckpointRecorded event");
    assert.equal(firstPrimary.eventType, "SessionStarted");
    assert.equal(firstPrimary.eventSchemaVersion, 1);
    assert.equal(secondPrimary.eventType, "SessionCheckpointRecorded");
    assert.equal(secondPrimary.eventSchemaVersion, 1);
    for (const [eventIndex, rawEvent] of primaryEvents.slice(2).entries()) {
      const event = record(rawEvent, `primary MemorySourceRecorded event ${eventIndex + 3}`);
      assert.equal(event.eventType, "MemorySourceRecorded");
      assert.equal(event.eventSchemaVersion, 2);
      const payload = record(event.payload, `primary MemorySourceRecorded payload ${eventIndex + 3}`);
      assert.equal(payload.sourceVersion, 2);
      assert.equal(typeof payload.itemId, "string");
      primaryItemIds.add(payload.itemId as string);
      primaryMemoryPayloads.push(payload);
    }
    assert.equal(primaryItemIds.size, 502);

    const competingEvent = record(competingEvents[0], "competing source event");
    assert.equal(competingEvent.eventType, "MemorySourceRecorded");
    assert.equal(competingEvent.eventSchemaVersion, 2);
    const competingPayload = record(competingEvent.payload, "competing source payload");
    assert.ok(primaryMemoryPayloads.some((payload) => (
      payload.normalizedKey === competingPayload.normalizedKey
      && payload.summary === competingPayload.summary
    )));

    const queries = judgmentsArtifact.queries;
    assert.ok(Array.isArray(queries));
    assert.equal(queries.length, 504);
    const classCounts = new Map<string, number>();
    const languageCounts = new Map<string, number>();
    for (const [index, rawQuery] of queries.entries()) {
      const query = record(rawQuery, `queries[${index}]`);
      assert.deepEqual([...Object.keys(query)].sort(), [
        "queryId", "language", "criticalClass", "queryText", "eligibleScope",
        "expectedCitations", "judgments", "relevanceGrades", "expectations",
      ].sort());
      assert.equal(query.queryId, `eval-v2-${String(index + 1).padStart(4, "0")}`);
      assert.equal(typeof query.queryText, "string");
      assert.equal((query.queryText as string).normalize("NFKC"), query.queryText);
      assert.equal(typeof query.criticalClass, "string");
      assert.equal(typeof query.language, "string");
      classCounts.set(query.criticalClass as string, (classCounts.get(query.criticalClass as string) ?? 0) + 1);
      languageCounts.set(query.language as string, (languageCounts.get(query.language as string) ?? 0) + 1);

      const grades = record(query.relevanceGrades, `queries[${index}].relevanceGrades`);
      const positiveItemIds = Object.entries(grades)
        .filter(([, grade]) => typeof grade === "number" && grade > 0)
        .map(([itemId]) => itemId);
      assert.ok(positiveItemIds.length > 0);
      assert.ok(positiveItemIds.every((itemId) => primaryItemIds.has(itemId)));
      assert.ok(Array.isArray(query.expectedCitations));
      assert.ok(query.expectedCitations.length > 0);
      for (const rawCitation of query.expectedCitations) {
        const citation = record(rawCitation, `queries[${index}].expectedCitations`);
        assert.ok(primaryItemIds.has(citation.itemId as string));
        assert.ok((grades[citation.itemId as string] as number | undefined ?? 0) > 0);
      }

      assert.ok(Array.isArray(query.judgments));
      assert.equal(query.judgments.length, 2);
      const firstJudgment = record(query.judgments[0], `queries[${index}].judgments[0]`);
      const secondJudgment = record(query.judgments[1], `queries[${index}].judgments[1]`);
      assert.notEqual(firstJudgment.judgeId, secondJudgment.judgeId);
      assert.deepEqual(firstJudgment.relevanceGrades, grades);
      assert.deepEqual(secondJudgment.relevanceGrades, grades);
      assertNoAnswerDerivedFields(query, `queries[${index}]`);
    }
    for (const criticalClass of RETRIEVAL_EVALUATION_CRITICAL_CLASSES) {
      assert.equal(classCounts.get(criticalClass), 56, `${criticalClass} needs exactly 56 cases`);
    }
    assert.equal(languageCounts.get("en"), 162);
    assert.equal(languageCounts.get("th"), 171);
    assert.equal(languageCounts.get("mixed"), 171);
    for (const criticalClass of RETRIEVAL_EVALUATION_CRITICAL_CLASSES) {
      const classQueries: UnknownRecord[] = queries.map((query) => record(query, "query"))
        .filter((query) => query.criticalClass === criticalClass);
      assert.equal(classQueries.filter((query) => query.language === "en").length, 18);
      assert.equal(classQueries.filter((query) => query.language === "th").length, 19);
      assert.equal(classQueries.filter((query) => query.language === "mixed").length, 19);
    }
    assert.doesNotMatch(
      JSON.stringify({ sourceArtifact, judgmentsArtifact }),
      /raw[-_ ]?evidence|authorization|credential|bearer\s|private[-_ ]?key/i,
    );
  });
});

const realHarnessRoots: string[] = [];
afterEach(() => {
  for (const root of realHarnessRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface StaticSealedV2Inputs {
  readonly manifest: UnknownRecord;
  readonly sourceEvents: UnknownRecord;
  readonly judgments: UnknownRecord;
  readonly baseline: UnknownRecord;
  readonly corpus: SealedRetrievalEvaluationCorpusV2;
}

function readStaticSealedV2Inputs(): StaticSealedV2Inputs {
  const manifest = record(JSON.parse(readFileSync(V2_MANIFEST_FIXTURE_URL, "utf8")) as unknown, "manifest");
  const sourceEvents = record(
    JSON.parse(readFileSync(V2_SOURCE_EVENTS_FIXTURE_URL, "utf8")) as unknown,
    "source-events",
  );
  const judgments = record(
    JSON.parse(readFileSync(V2_JUDGMENTS_FIXTURE_URL, "utf8")) as unknown,
    "judgments",
  );
  const baseline = record(
    JSON.parse(readFileSync(V2_V1_SHADOW_BASELINE_FIXTURE_URL, "utf8")) as unknown,
    "v1 shadow baseline",
  );
  return Object.freeze({
    manifest,
    sourceEvents,
    judgments,
    baseline,
    corpus: parseSealedRetrievalEvaluationBundle(manifest, sourceEvents, judgments, baseline),
  });
}

function rawText(source: UnknownRecord, key: string): string {
  const value = source[key];
  assert.equal(typeof value, "string", `${key} must be a string`);
  return value as string;
}

function rawInteger(source: UnknownRecord, key: string): number {
  const value = source[key];
  assert.equal(typeof value, "number", `${key} must be a number`);
  assert.equal(Number.isSafeInteger(value), true, `${key} must be an integer`);
  return value as number;
}

function rawNullableText(source: UnknownRecord, key: string): string | null {
  const value = source[key];
  assert.ok(value === null || typeof value === "string", `${key} must be text or null`);
  return value as string | null;
}

interface AuthenticatedSourceStore {
  readonly binding: ProjectBinding;
  readonly eventStorePath: string;
  readonly terminalPosition: bigint;
}

function createAuthenticatedSourceStore(
  root: string,
  source: SealedRetrievalEvaluationCorpusV2["sources"][number],
  ordinal: number,
): AuthenticatedSourceStore {
  const eventStorePath = join(root, `source-${ordinal}.sqlite`);
  const database = new DatabaseSync(eventStorePath);
  try {
    database.exec(`
      PRAGMA application_id = ${PROJECT_MEMORY_APPLICATION_ID};
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE project_meta(singleton INTEGER PRIMARY KEY, project_id TEXT, vault_id TEXT, store_id TEXT) STRICT;
      CREATE TABLE events(
        global_position INTEGER PRIMARY KEY, event_id TEXT, project_id TEXT, vault_id TEXT,
        store_id TEXT, workspace_id TEXT, branch_scope_id TEXT, branch_ref TEXT,
        stream_id TEXT, stream_type TEXT, stream_version INTEGER, event_type TEXT,
        event_schema_version INTEGER, session_id TEXT, parent_session_id TEXT,
        actor_role TEXT, agent_id TEXT, client_instance_id TEXT, correlation_id TEXT,
        causation_id TEXT, command_id TEXT, idempotency_key TEXT, command_event_index INTEGER,
        occurred_at TEXT, recorded_at TEXT, visibility_scope TEXT, confidence TEXT,
        verification_status TEXT, source_refs_json TEXT, evidence_refs_json TEXT,
        evidence_digests_json TEXT, payload_json TEXT, payload_hash TEXT,
        previous_global_hash TEXT, event_hash TEXT, lifecycle_intent_json TEXT
      ) STRICT;
    `);
    database.prepare("INSERT INTO project_meta VALUES (1, ?, ?, ?)").run(
      source.binding.projectId,
      source.binding.vaultId,
      source.binding.storeId,
    );
    const insert = database.prepare(`
      INSERT INTO events(
        global_position, event_id, project_id, vault_id, store_id, workspace_id,
        branch_scope_id, branch_ref, stream_id, stream_type, stream_version, event_type,
        event_schema_version, session_id, parent_session_id, actor_role, agent_id,
        client_instance_id, correlation_id, causation_id, command_id, idempotency_key,
        command_event_index, occurred_at, recorded_at, visibility_scope, confidence,
        verification_status, source_refs_json, evidence_refs_json, evidence_digests_json,
        payload_json, payload_hash, previous_global_hash, event_hash, lifecycle_intent_json
      ) VALUES (
        $globalPosition, $eventId, $projectId, $vaultId, $storeId, $workspaceId,
        $branchScopeId, $branchRef, $streamId, $streamType, $streamVersion, $eventType,
        $eventSchemaVersion, $sessionId, $parentSessionId, $actorRole, $agentId,
        $clientInstanceId, $correlationId, $causationId, $commandId, $idempotencyKey,
        $commandEventIndex, $occurredAt, $recordedAt, $visibilityScope, $confidence,
        $verificationStatus, $sourceRefsJson, $evidenceRefsJson, $evidenceDigestsJson,
        $payloadJson, $payloadHash, $previousGlobalHash, $eventHash, $lifecycleIntentJson
      )
    `);
    let previousGlobalHash = GENESIS_GLOBAL_HASH;
    for (const [index, rawEvent] of source.events.entries()) {
      const event = record(rawEvent, `source ${ordinal} event ${index + 1}`);
      const payload = event.payload as JsonValue;
      const payloadJson = canonicalJson(payload);
      const recomputedPayloadHash = storedPayloadHash(payload);
      const recomputedEventHash = storedEventHash(rawStoredEventHashInput(event));
      assert.equal(rawText(event, "payloadJson"), payloadJson);
      assert.equal(rawText(event, "payloadHash"), recomputedPayloadHash);
      assert.equal(rawText(event, "previousGlobalHash"), previousGlobalHash);
      assert.equal(rawText(event, "eventHash"), recomputedEventHash);
      insert.run({
        $globalPosition: BigInt(rawText(event, "globalPosition")),
        $eventId: rawText(event, "eventId"),
        $projectId: rawText(event, "projectId"),
        $vaultId: rawText(event, "vaultId"),
        $storeId: rawText(event, "storeId"),
        $workspaceId: rawText(event, "workspaceId"),
        $branchScopeId: rawNullableText(event, "branchScopeId"),
        $branchRef: rawNullableText(event, "branchRef"),
        $streamId: rawText(event, "streamId"),
        $streamType: rawText(event, "streamType"),
        $streamVersion: BigInt(rawText(event, "streamVersion")),
        $eventType: rawText(event, "eventType"),
        $eventSchemaVersion: rawInteger(event, "eventSchemaVersion"),
        $sessionId: rawNullableText(event, "sessionId"),
        $parentSessionId: rawNullableText(event, "parentSessionId"),
        $actorRole: rawText(event, "actorRole"),
        $agentId: rawText(event, "agentId"),
        $clientInstanceId: rawText(event, "clientInstanceId"),
        $correlationId: rawText(event, "correlationId"),
        $causationId: rawNullableText(event, "causationId"),
        $commandId: rawText(event, "commandId"),
        $idempotencyKey: rawText(event, "idempotencyKey"),
        $commandEventIndex: rawInteger(event, "commandEventIndex"),
        $occurredAt: rawText(event, "occurredAt"),
        $recordedAt: rawText(event, "recordedAt"),
        $visibilityScope: rawText(event, "visibilityScope"),
        $confidence: rawText(event, "confidence"),
        $verificationStatus: rawText(event, "verificationStatus"),
        $sourceRefsJson: canonicalJson(event.sourceRefs as JsonValue),
        $evidenceRefsJson: canonicalJson(event.evidenceRefs as JsonValue),
        $evidenceDigestsJson: canonicalJson(event.evidenceDigests as JsonValue),
        $payloadJson: payloadJson,
        $payloadHash: recomputedPayloadHash,
        $previousGlobalHash: previousGlobalHash,
        $eventHash: recomputedEventHash,
        $lifecycleIntentJson: rawNullableText(event, "lifecycleIntentJson"),
      });
      previousGlobalHash = recomputedEventHash;
    }
  } finally {
    database.close();
  }
  const terminal = source.events.at(-1);
  assert.ok(terminal);
  return Object.freeze({
    binding: source.binding,
    eventStorePath,
    terminalPosition: BigInt(rawText(record(terminal, "terminal event"), "globalPosition")),
  });
}

function v1ManifestView(manifest: ProjectionManifestV2): ProjectionManifestV1 {
  const checksums = manifest.coreChecksums;
  return Object.freeze({
    schemaVersion: 1,
    projectId: manifest.projectId,
    vaultId: manifest.vaultId,
    storeId: manifest.storeId,
    workspaceId: manifest.workspaceId,
    branchScopeId: manifest.branchScopeId,
    branchRef: manifest.branchRef,
    sessionId: manifest.sessionId,
    generation: manifest.generation,
    terminalEventPosition: manifest.terminalEventPosition,
    terminalEventHash: manifest.terminalEventHash,
    databaseFile: `projections-1-${String(manifest.generation)}.sqlite`,
    databaseSha256: manifest.databaseSha256,
    coreChecksums: Object.freeze({
      sessionTree: checksums.sessionTree,
      canonicalItems: checksums.canonicalItems,
      tasksFollowups: checksums.tasksFollowups,
      artifactsFiles: checksums.artifactsFiles,
      entityGraph: checksums.entityGraph,
      lexicalChunks: checksums.lexicalChunks,
      retrievalFeedback: checksums.retrievalFeedback,
    }),
    createdAt: manifest.createdAt,
  });
}

interface RealEvaluationHarness {
  readonly corpus: SealedRetrievalEvaluationCorpusV2;
  readonly primary: AuthenticatedSourceStore;
  readonly competing: AuthenticatedSourceStore;
  readonly v1Coordinator: DefaultProjectionBuildCoordinator;
  readonly primaryV2Coordinator: V2ProjectionBuildCoordinator;
  readonly competingV2Coordinator: V2ProjectionBuildCoordinator;
  readonly primaryV2DatabasePath: string;
  readonly competingV2DatabasePath: string;
}

async function createRealEvaluationHarness(): Promise<RealEvaluationHarness> {
  const staticInputs = readStaticSealedV2Inputs();
  assert.equal(staticInputs.corpus.sources.length, 2);
  const root = mkdtempSync(join(tmpdir(), "retrieval-evaluation-v2-"));
  realHarnessRoots.push(root);
  const [primarySource, competingSource] = staticInputs.corpus.sources;
  assert.ok(primarySource);
  assert.ok(competingSource);
  const primary = createAuthenticatedSourceStore(root, primarySource, 1);
  const competing = createAuthenticatedSourceStore(root, competingSource, 2);
  const driver = new NodeSqliteDriver({ DatabaseSync });
  const primaryV1Directory = join(root, "primary-v1");
  const primaryV2Directory = join(root, "primary-v2");
  const competingV2Directory = join(root, "competing-v2");
  const v1Coordinator = new DefaultProjectionBuildCoordinator({
    projectionDirectory: primaryV1Directory,
    eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: primary.eventStorePath }),
    builder: new ImmutableProjectionBuilder({ driver, projectionDirectory: primaryV1Directory }),
  });
  const primaryV2Coordinator = new V2ProjectionBuildCoordinator({
    projectionDirectory: primaryV2Directory,
    eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: primary.eventStorePath }),
    builder: new ImmutableProjectionBuilder({ driver, projectionDirectory: primaryV2Directory }),
  });
  const competingV2Coordinator = new V2ProjectionBuildCoordinator({
    projectionDirectory: competingV2Directory,
    eventReader: new SqliteProjectionEventReader({ driver, eventStorePath: competing.eventStorePath }),
    builder: new ImmutableProjectionBuilder({ driver, projectionDirectory: competingV2Directory }),
  });
  await v1Coordinator.ensurePublished(primary.binding, primary.terminalPosition, 30_000);
  const primaryV2 = await primaryV2Coordinator.ensurePublished(
    primary.binding,
    primary.terminalPosition,
    30_000,
  );
  const competingV2 = await competingV2Coordinator.ensurePublished(
    competing.binding,
    competing.terminalPosition,
    30_000,
  );
  return Object.freeze({
    corpus: staticInputs.corpus,
    primary,
    competing,
    v1Coordinator,
    primaryV2Coordinator,
    competingV2Coordinator,
    primaryV2DatabasePath: primaryV2.databasePath,
    competingV2DatabasePath: competingV2.databasePath,
  });
}

function createRealV1EvaluationService(
  coordinator: DefaultProjectionBuildCoordinator,
  binding: ProjectBinding,
): InternalRetrievalService {
  const projections: ProjectionLeaseProvider = {
    async pin(requestBinding): Promise<ProjectionReaderLease> {
      assert.deepEqual(requestBinding, binding);
      return coordinator.leasePublished(requestBinding);
    },
  };
  return new InternalRetrievalService({
    projections,
    candidates: new SqliteRetrievalCandidateRepository(),
  });
}

interface V2EvaluationBridge {
  readonly service: InternalRetrievalService;
  readonly originalLeaseAdapter: V2SqliteRetrievalCandidateRepository;
  readonly originalLease: V2ProjectionReaderLease;
  readonly databasePathReads: () => number;
  readonly adapterCalls: () => number;
  close(): void;
}

async function createV2EvaluationBridge(
  coordinator: V2ProjectionBuildCoordinator,
  binding: ProjectBinding,
): Promise<V2EvaluationBridge> {
  const originalLeases = new WeakMap<ProjectionReaderLease, V2ProjectionReaderLease>();
  const adapter = new V2SqliteRetrievalCandidateRepository();
  const originalLease = await coordinator.leasePublishedForEvaluation(binding);
  let databasePathReads = 0;
  let adapterCalls = 0;
  let closed = false;
  const projections: ProjectionLeaseProvider = {
    async pin(requestBinding): Promise<ProjectionReaderLease> {
      assert.deepEqual(requestBinding, binding);
      assert.equal(closed, false, "V2 evaluation bridge must retain its verified lease");
      let view: ProjectionReaderLease;
      view = Object.freeze({
        manifest: v1ManifestView(originalLease.manifest),
        get databasePath(): string {
          databasePathReads += 1;
          throw new Error("V2 evaluation bridge must not read a V1 database path");
        },
        close(): void {
          originalLeases.delete(view);
        },
      });
      originalLeases.set(view, originalLease);
      return view;
    },
  };
  const candidates: RetrievalCandidateRepository = {
    collectEligible(lease, request): RetrievalCandidateCollection {
      const original = originalLeases.get(lease);
      assert.ok(original, "V2 candidate adapter must receive its preserved original lease");
      adapterCalls += 1;
      return adapter.collectEligible(original, request);
    },
  };
  return Object.freeze({
    service: new InternalRetrievalService({ projections, candidates }),
    originalLeaseAdapter: adapter,
    originalLease,
    databasePathReads: () => databasePathReads,
    adapterCalls: () => adapterCalls,
    close(): void {
      if (closed) return;
      closed = true;
      originalLease.close();
    },
  });
}

function directSourceRequest(
  binding: ProjectBinding,
  eventPosition: bigint,
  sessionId: string,
  query: string,
): InternalRetrievalRequest {
  return Object.freeze({
    binding,
    query,
    limit: 10,
    tokenBudget: 32_768,
    consistency: Object.freeze({ requiredEventPosition: eventPosition, deadlineMs: 30_000 }),
    candidateLimit: 512,
    explain: false,
    includeGlobal: false,
    visibility: "session",
    vector: Object.freeze({ enabled: false }),
    sessionId,
    validAt: "2026-08-28T00:00:00.000Z",
    knownAt: eventPosition,
  });
}

function candidateItemIds(collection: RetrievalCandidateCollection): readonly string[] {
  return Object.freeze(collection.channels.flatMap((channel) => (
    channel.candidates.map((candidate) => candidate.item.id)
  )));
}

describe("real sealed V1/V2 retrieval evaluator harness", () => {
  it("hydrates authenticated sources, reproduces V1, and seals V2 through the detached lease bridge", async () => {
    const harness = await createRealEvaluationHarness();
    const v1Service = createRealV1EvaluationService(harness.v1Coordinator, harness.primary.binding);
    const v1Report = await evaluateRetrievalQueries(
      harness.corpus.queries,
      "retrieval-evaluation-v1",
      v1Service,
    );
    assert.deepEqual(v1Report, harness.corpus.baseline.metrics);

    const bridge = await createV2EvaluationBridge(
      harness.primaryV2Coordinator,
      harness.primary.binding,
    );
    try {
      const v2Report = await evaluateSealedRetrieval(harness.corpus, bridge.service);
    assert.equal(v2Report.corpusVersion, "retrieval-evaluation-v2");
    assert.equal(Object.isFrozen(v2Report), true);
    assert.doesNotMatch(JSON.stringify(v2Report), /queryText|expectedCitations|relevanceGrades|projectId/);
    if (process.env.RETRIEVAL_EVALUATION_REAL_REPORT === "sealed-v2") {
      process.stdout.write(`${JSON.stringify(v2Report)}\n`);
    }
    assert.equal(bridge.databasePathReads(), 0);
    assert.equal(bridge.adapterCalls(), harness.corpus.queries.length);

    const primaryEvent = record(harness.corpus.sources[0]!.events[2], "primary memory event");
    const primaryPayload = record(primaryEvent.payload, "primary memory payload");
    {
      const primaryRequest = directSourceRequest(
        harness.primary.binding,
        harness.primary.terminalPosition,
        rawText(primaryEvent, "sessionId"),
        rawText(primaryPayload, "normalizedKey"),
      );
      const baselineCandidates = candidateItemIds(
        bridge.originalLeaseAdapter.collectEligible(bridge.originalLease, primaryRequest),
      );
      assert.ok(baselineCandidates.includes(rawText(primaryPayload, "itemId")));
      const competingEvent = record(harness.corpus.sources[1]!.events[0], "competing memory event");
      const competingPayload = record(competingEvent.payload, "competing memory payload");
      assert.equal(baselineCandidates.includes(rawText(competingPayload, "itemId")), false);

      const originalPath = harness.primaryV2DatabasePath;
      const displacedPath = `${originalPath}.sealed-original`;
      renameSync(originalPath, displacedPath);
      copyFileSync(harness.competingV2DatabasePath, originalPath);
      assert.deepEqual(
        candidateItemIds(bridge.originalLeaseAdapter.collectEligible(bridge.originalLease, primaryRequest)),
        baselineCandidates,
      );
      rmSync(originalPath, { force: true });
      renameSync(displacedPath, originalPath);

      const competingLease = await harness.competingV2Coordinator.leasePublishedForEvaluation(
        harness.competing.binding,
      );
      try {
        const competingRequest = directSourceRequest(
          harness.competing.binding,
          harness.competing.terminalPosition,
          rawText(competingEvent, "sessionId"),
          rawText(competingPayload, "normalizedKey"),
        );
        assert.ok(candidateItemIds(bridge.originalLeaseAdapter.collectEligible(
          competingLease,
          competingRequest,
        )).includes(rawText(competingPayload, "itemId")));
      } finally {
        competingLease.close();
      }
    }

    const [firstQuery] = harness.corpus.queries;
    assert.ok(firstQuery);
    const contaminated = Object.freeze({
      async retrieve(request: InternalRetrievalRequest) {
        const result = await bridge.service.retrieve(request);
        if (request.query !== firstQuery.queryText) return result;
        const first = result.items[0];
        assert.ok(first);
        return Object.freeze({
          ...result,
          items: Object.freeze([first, Object.freeze({ ...first, projectId: harness.competing.binding.projectId })]),
        });
      },
    });
    const contaminationReport = await evaluateRetrievalQueries(
      Object.freeze([firstQuery]),
      "retrieval-evaluation-v2",
      contaminated,
    );
    assert.equal(contaminationReport.crossProjectContamination, 1);
    } finally {
      bridge.close();
    }
  });
});

describe("sealed V2 threshold predicate", () => {
  it("independently rejects valid absolute and reachable baseline regressions", async () => {
    const sealed = readStaticSealedV2Inputs().corpus;
    const fixture = createEvaluationService(sealed as unknown as RetrievalEvaluationCorpusV1);
    const report = Object.freeze({
      ...sealed.baseline.metrics,
      corpusVersion: "retrieval-evaluation-v2" as const,
    });
    const reject = (
      label: string,
      changes: Partial<RetrievalEvaluationReport>,
      baselineChanges: Partial<RetrievalEvaluationReport> = {},
    ): void => {
      const candidate = Object.freeze({ ...report, ...changes });
      const baseline = Object.freeze({ ...sealed.baseline.metrics, ...baselineChanges });
      assert.throws(
        () => assertSealedRetrievalThresholds(candidate, baseline),
        (error: unknown) => error instanceof RetrievalEvaluationCorpusError,
        label,
      );
    };
    const rejectAbsolute = (
      label: string,
      changes: Partial<RetrievalEvaluationReport>,
    ): void => reject(label, changes, changes);

    assert.doesNotThrow(() => assertSealedRetrievalThresholds(report, sealed.baseline.metrics));
    const integrated = await evaluateSealedRetrieval(sealed, fixture.service);
    assert.equal(integrated.corpusVersion, "retrieval-evaluation-v2");

    rejectAbsolute("failed query count", { failedQueryCount: 1 });
    rejectAbsolute("cross-project contamination", { crossProjectContamination: 1 });
    rejectAbsolute("recall", { recallAt10: 0.949 });
    rejectAbsolute("MRR", { mrr: 0.899 });
    rejectAbsolute("NDCG", { ndcgAt10: 0.899 });
    rejectAbsolute("citation precision", { citationPrecision: 0.949 });
    rejectAbsolute("citation recall", { citationRecall: 0.949 });
    rejectAbsolute("stale-active rate", { staleActiveMemoryRate: 0.011 });
    rejectAbsolute("exact identifier", { exactIdentifierPathRecall: 0.999 });
    rejectAbsolute("checkpoint", { currentSessionCheckpointRecallAt10: 0.999 });
    rejectAbsolute("open follow-up", { openFollowUpRecallAt10: 0.999 });
    rejectAbsolute("next action", { nextActionRecallAt10: 0.999 });
    rejectAbsolute("semantic paraphrase", { semanticParaphraseRecallAt10: 0.899 });
    rejectAbsolute("bitemporal", { bitemporalAccuracy: 0.949 });
    rejectAbsolute("conflict recall", { conflictRecall: 0.999 });
    rejectAbsolute("conflict precision", { conflictPrecision: 0.999 });
    rejectAbsolute("unsupported high-impact claims", { unsupportedHighImpactVerifiedClaims: 1 });

    for (const metric of [
      "recallAt10", "mrr", "ndcgAt10", "citationPrecision", "citationRecall",
      "semanticParaphraseRecallAt10", "bitemporalAccuracy",
    ] as const) {
      reject(`V1 baseline ${metric}`, { [metric]: 0.99 });
    }
    reject(
      "V1 baseline stale-active rate",
      { staleActiveMemoryRate: 0.005 },
    );

    for (const metric of [
      "exactIdentifierPathRecall", "currentSessionCheckpointRecallAt10",
      "openFollowUpRecallAt10", "nextActionRecallAt10", "conflictRecall", "conflictPrecision",
    ] as const) {
      assert.equal(report[metric], 1, `${metric} absolute gate fixes the report at one`);
      assert.ok(sealed.baseline.metrics[metric] <= 1, `${metric} baseline is parser-valid`);
    }
    assert.equal(report.unsupportedHighImpactVerifiedClaims, 0);
    assert.ok(sealed.baseline.metrics.unsupportedHighImpactVerifiedClaims >= 0);
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
  it("passes one shared runtime deadline without changing the sealed query limit and propagates expiry", async () => {
    const corpus = readCorpus();
    const query = corpus.queries[0]!;
    const deadline: ShadowMigrationInvocationDeadline = {
      signal: new AbortController().signal,
      remainingMs: () => 50,
    };
    let calls = 0;
    const service = Object.freeze({
      async retrieve(request: InternalRetrievalRequest, received?: ShadowMigrationInvocationDeadline) {
        calls += 1;
        assert.equal(received, deadline);
        assert.equal(request.consistency.deadlineMs, query.eligibleScope.deadlineMs);
        throw new ShadowMigrationError("MIGRATION_RETRY_EXHAUSTED");
      },
    });

    await assert.rejects(
      evaluateRetrievalQueries([query], "retrieval-evaluation-v2", service, deadline),
      (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED",
    );
    assert.equal(calls, 1);
  });

  it("hard-disables sealed vectors before any retrieval and accumulates V2 reports", async () => {
    let retrievals = 0;
    assert.throws(
      () => assertSealedEvaluationVectorDisabled(Object.freeze({ enabled: true })),
      (error: unknown) => error instanceof RetrievalEvaluationCorpusError,
    );
    assert.doesNotThrow(() => assertSealedEvaluationVectorDisabled(Object.freeze({ enabled: false })));

    const corpus = readCorpus();
    const fixture = createEvaluationService(corpus);
    const service = Object.freeze({
      async retrieve(request: InternalRetrievalRequest) {
        retrievals += 1;
        assert.ok(request.vector);
        assert.equal(request.vector.enabled, false);
        assert.equal(Object.isFrozen(request.vector), true);
        return fixture.service.retrieve(request);
      },
    });

    const report = await evaluateRetrievalQueries(
      Object.freeze([corpus.queries[0]!]),
      "retrieval-evaluation-v2",
      service,
    );

    assert.equal(report.corpusVersion, "retrieval-evaluation-v2");
    assert.equal(report.queryCount, 1);
    assert.equal(report.failedQueryCount, 0);
    assert.equal(retrievals, 1);
  });

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
