import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

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
import { PROJECTION_SCHEMA_SQL_V1 } from "../src/orchestrator/projections/schema.js";
import { SqliteRetrievalCandidateRepository } from "../src/orchestrator/retrieval/candidates.js";
import {
  InternalRetrievalError,
  RETRIEVAL_LIMITS,
  validateInternalRetrievalRequest,
  type InternalRetrievalRequest,
  type ProjectionLeaseProvider,
  type RetrievalCandidate,
  type RetrievalCandidateRepository,
  type RetrievalConflictGroup,
  type RetrievalItem,
} from "../src/orchestrator/retrieval/contracts.js";
import {
  estimateCandidateTokens,
  type FusedCandidate,
  type RetrievalRanker,
} from "../src/orchestrator/retrieval/ranking.js";
import { InternalRetrievalService } from "../src/orchestrator/retrieval/service.js";
import { ShadowMigrationError } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import type { ShadowMigrationInvocationDeadline } from "../src/orchestrator/migration/v2-shadow-migration-runtime.js";

const PROJECT_ID = "1".repeat(64) as ProjectId;
const OTHER_PROJECT_ID = "9".repeat(64) as ProjectId;
const WORKSPACE_ID = "2".repeat(64) as WorkspaceId;
const BRANCH_SCOPE_ID = "00000000-0000-4000-8000-000000000521" as BranchScopeId;
const ITEM_ID = "00000000-0000-4000-8000-000000000522";
const FEEDBACK_PEER_ID = "00000000-0000-4000-8000-000000000524";

const BINDING: ProjectBinding = Object.freeze({
  projectId: PROJECT_ID,
  vaultId: "3".repeat(64) as VaultId,
  storeId: "4".repeat(64) as StoreId,
  workspaceId: WORKSPACE_ID,
  branchScopeId: BRANCH_SCOPE_ID,
  branchRef: "refs/heads/task-5",
  sessionId: null,
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createLease(onClose: () => void): ProjectionReaderLease {
  const root = mkdtempSync(join(tmpdir(), "retrieval-service-"));
  roots.push(root);
  const databasePath = join(root, "projections-1-1.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(PROJECTION_SCHEMA_SQL_V1);
  database.prepare(`
    UPDATE projection_metadata SET
      project_id = ?, vault_id = ?, store_id = ?, workspace_id = ?,
      branch_scope_id = ?, branch_ref = ?, session_id = NULL, generation = 1,
      terminal_event_position = 12, terminal_event_hash = ?, created_at = ?
    WHERE singleton = 1
  `).run(
    BINDING.projectId,
    BINDING.vaultId,
    BINDING.storeId,
    BINDING.workspaceId,
    BINDING.branchScopeId,
    BINDING.branchRef,
    "a".repeat(64),
    "2026-08-24T00:00:00.000Z",
  );
  const insert = database.prepare(`
    INSERT INTO canonical_items(
      project_id, item_id, normalized_key, status, confidence, verification_method,
      valid_from, valid_to, summary, content_hash, known_from_event_position,
      source_event_position
    ) VALUES (?, ?, ?, 'verified', 'high', 'committed-event', ?, NULL, ?, ?, ?, ?)
  `);
  insert.run(PROJECT_ID, ITEM_ID, "decision:same-task", "2026-01-01T00:00:00.000Z", "same-task", "5".repeat(64), 7, 8);
  insert.run(OTHER_PROJECT_ID, "00000000-0000-4000-8000-000000000523", "decision:other", "2026-01-01T00:00:00.000Z", "same-task", "6".repeat(64), 2, 2);
  database.prepare(`
    INSERT INTO lexical_chunks(
      project_id, chunk_id, item_id, session_id, section, normalized_key, text,
      source_event_position
    ) VALUES (?, 'chunk-service', ?, NULL, 'summary', 'decision:same-task',
              'same-task', 8)
  `).run(PROJECT_ID, ITEM_ID);
  database.close();

  const manifest: ProjectionManifestV1 = Object.freeze({
    schemaVersion: 1,
    projectId: BINDING.projectId,
    vaultId: BINDING.vaultId,
    storeId: BINDING.storeId,
    workspaceId: BINDING.workspaceId,
    branchScopeId: BINDING.branchScopeId,
    branchRef: BINDING.branchRef,
    sessionId: null,
    generation: 1,
    terminalEventPosition: "12",
    terminalEventHash: "a".repeat(64),
    databaseFile: "projections-1-1.sqlite",
    databaseSha256: "b".repeat(64),
    coreChecksums: Object.freeze({
      sessionTree: "c".repeat(64), canonicalItems: "d".repeat(64),
      tasksFollowups: "e".repeat(64), artifactsFiles: "f".repeat(64),
      entityGraph: "1".repeat(64), lexicalChunks: "2".repeat(64),
      retrievalFeedback: "3".repeat(64),
    }),
    createdAt: "2026-08-24T00:00:00.000Z",
  });
  return Object.freeze({ manifest, databasePath, close: onClose });
}

function request(overrides: Partial<InternalRetrievalRequest> = {}): InternalRetrievalRequest {
  return Object.freeze({
    binding: BINDING,
    query: "decision:same-task",
    limit: 10,
    tokenBudget: 1_200,
    consistency: Object.freeze({ requiredEventPosition: 12n, deadlineMs: 100 }),
    ...overrides,
  });
}

it("accepts production or legacy binding identities without weakening request guards", () => {
  const uuid = "12345678-abcd-4abc-8abc-123456789012";
  assert.deepEqual(validateInternalRetrievalRequest(request()).binding, BINDING);
  const production = { ...BINDING, projectId: uuid as ProjectId, vaultId: uuid as VaultId, storeId: uuid as StoreId };
  assert.deepEqual(validateInternalRetrievalRequest(request({ binding: production })).binding, production);
  for (const field of ["projectId", "vaultId", "storeId"] as const) {
    for (const value of [uuid.toUpperCase(), uuid.replace("-4abc-", "-1abc-"), uuid.slice(1), "g".repeat(64), "a".repeat(63), `${uuid}\0`, 7, null]) {
      assert.throws(() => validateInternalRetrievalRequest(request({ binding: { ...production, [field]: value } as ProjectBinding })));
    }
  }
  assert.throws(() => validateInternalRetrievalRequest(request({ binding: { ...production, workspaceId: uuid as WorkspaceId } })));
  assert.throws(() => validateInternalRetrievalRequest(request({ binding: { ...production, sessionId: uuid } as ProjectBinding })));
  let reads = 0;
  const accessor = { ...production };
  Object.defineProperty(accessor, "projectId", { enumerable: true, get() { reads++; return uuid; } });
  assert.throws(() => validateInternalRetrievalRequest(request({ binding: accessor })));
  assert.equal(reads, 0);
});

function staticItem(id: string, overrides: Partial<RetrievalItem> = {}): RetrievalItem {
  return Object.freeze({
    id,
    kind: "canonical",
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    branchScopeId: BRANCH_SCOPE_ID,
    branchRef: BINDING.branchRef,
    sessionId: null,
    visibility: "project",
    status: "verified",
    confidence: "high",
    verificationMethod: "committed-event",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    knownFromEventPosition: 7n,
    sourceEventPosition: 8n,
    summary: "ranker fixture",
    normalizedKey: `ranker:${id}`,
    anchor: null,
    freshness: "fresh",
    conflictGroupId: null,
    supersedingItemId: null,
    retrievalFeedbackScoreUnits: 0,
    ...overrides,
  });
}

function exactCandidate(id: string, rank: number, item: RetrievalItem): RetrievalCandidate {
  return Object.freeze({ candidateId: id, channel: "exact", rank, item });
}

function staticRepository(
  candidates: readonly RetrievalCandidate[],
  conflictGroups: readonly RetrievalConflictGroup[] = [],
): RetrievalCandidateRepository {
  const collection = Object.freeze({
    channels: Object.freeze([Object.freeze({ channel: "exact" as const, candidates })]),
    eligibleItemCount: candidates.length,
    droppedItemCount: 0,
    truncated: false,
    conflictGroups,
  });
  return Object.freeze({ collectEligible() { return collection; } });
}

function serviceWith(
  ranker: RetrievalRanker,
  candidates: RetrievalCandidateRepository,
  onClose: () => void,
): InternalRetrievalService {
  const lease = createLease(onClose);
  return new InternalRetrievalService({
    projections: { async pin() { return lease; } },
    candidates,
    ranker,
  });
}

describe("internal retrieval service", () => {
  it("settles a pending pin, narrows its timeout, closes once, and preserves deadline over close failure", async () => {
    let releasePin!: (lease: ProjectionReaderLease) => void;
    const pending = new Promise<ProjectionReaderLease>((resolve) => { releasePin = resolve; });
    let closed = 0;
    let pinDeadline: number | undefined;
    let checks = 0;
    const deadline: ShadowMigrationInvocationDeadline = {
      signal: new AbortController().signal,
      remainingMs() {
        checks += 1;
        if (checks > 1) throw new ShadowMigrationError("MIGRATION_RETRY_EXHAUSTED");
        return 25;
      },
    };
    const service = new InternalRetrievalService({
      projections: {
        async pin(_binding, consistency) {
          pinDeadline = consistency?.deadlineMs;
          return pending;
        },
      },
      candidates: staticRepository([]),
    });

    const retrieval = service.retrieve(request({ consistency: { requiredEventPosition: 12n, deadlineMs: 100 } }), deadline);
    await Promise.resolve();
    assert.equal(pinDeadline, 25);
    releasePin(createLease(() => { closed += 1; throw new Error("secondary-close-failure"); }));
    await assert.rejects(retrieval, (error: unknown) => (
      error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED"
    ));
    assert.equal(closed, 1);
  });

  it("preserves a typed migration timeout raised by the vector channel", async () => {
    let closed = 0;
    const service = new InternalRetrievalService({
      projections: { async pin() { return createLease(() => { closed += 1; }); } },
      candidates: staticRepository([]),
      vectorChannel: {
        async search() {
          throw new ShadowMigrationError("MIGRATION_RETRY_EXHAUSTED");
        },
      },
    });

    await assert.rejects(
      service.retrieve(request({ vector: Object.freeze({ enabled: true }) })),
      (error: unknown) => (
        error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED"
      ),
    );
    assert.equal(closed, 1);
  });

  it("applies shared result bounds after a custom ranker reorders exact fused references", async () => {
    const first = staticItem("00000000-0000-4000-8000-000000000528");
    const second = staticItem("00000000-0000-4000-8000-000000000529");
    const candidates = staticRepository(Object.freeze([
      exactCandidate("canonical:first", 1, first),
      exactCandidate("canonical:second", 2, second),
    ]));
    let observed: readonly FusedCandidate[] | undefined;
    let returned: readonly FusedCandidate[] | undefined;
    const ranker: RetrievalRanker = {
      select(eligible) {
        observed = eligible;
        returned = Object.freeze([...eligible].reverse());
        return returned;
      },
    };
    let closed = 0;

    const result = await serviceWith(ranker, candidates, () => { closed += 1; }).retrieve(
      request({ limit: 1 }),
    );

    assert.deepEqual(result.items.map((item) => item.id), [second.id]);
    assert.equal(result.candidateCount, 2);
    assert.equal(result.redactedDropCounts.byReason.resultLimit, 1);
    assert.equal(returned?.every((candidate) => observed?.includes(candidate) === true), true);
    assert.equal(closed, 1);
  });

  it("fails closed when a custom ranker returns a cloned fused candidate", async () => {
    const first = staticItem("00000000-0000-4000-8000-000000000530");
    const second = staticItem("00000000-0000-4000-8000-000000000531");
    const candidates = staticRepository(Object.freeze([
      exactCandidate("canonical:first", 1, first),
      exactCandidate("canonical:second", 2, second),
    ]));
    const invalidRanker: RetrievalRanker = {
      select(eligible) {
        return Object.freeze([{ ...eligible[0]! }, ...eligible.slice(1)]);
      },
    };
    let closed = 0;

    await assert.rejects(
      () => serviceWith(invalidRanker, candidates, () => { closed += 1; }).retrieve(request()),
      (error: unknown) => error instanceof InternalRetrievalError
        && error.code === "RETRIEVAL_RANKER_INVALID",
    );

    assert.equal(closed, 1);
  });

  it("uses the shared selector's conflict, drop, and explanation bounds after custom ranking", async () => {
    const conflictGroupId = "ranker:conflict";
    const first = staticItem("00000000-0000-4000-8000-000000000532", {
      status: "conflicted",
      normalizedKey: "ranker:conflict:A",
      summary: "A",
      conflictGroupId,
    });
    const second = staticItem("00000000-0000-4000-8000-000000000533", {
      status: "conflicted",
      normalizedKey: "ranker:conflict:B",
      summary: "B",
      conflictGroupId,
    });
    const later = staticItem("00000000-0000-4000-8000-000000000534", {
      normalizedKey: "ranker:later",
      summary: "C",
    });
    const candidates = staticRepository(Object.freeze([
      exactCandidate("canonical:conflict:A", 1, first),
      exactCandidate("canonical:conflict:B", 2, second),
      exactCandidate("canonical:later", 3, later),
    ]), Object.freeze([Object.freeze({
      conflictGroupId,
      eligibleMemberCount: 2,
      returnedMemberCount: 2,
      truncated: false,
      cursor: "opaque-conflict-cursor",
    })]));
    const ranker: RetrievalRanker = { select(eligible) { return eligible; } };
    const tokenBudget = estimateCandidateTokens({ id: `canonical:${first.id}`, item: first });

    const result = await serviceWith(ranker, candidates, () => undefined).retrieve(
      request({ tokenBudget, explain: true }),
    );

    assert.deepEqual(result.items.map((item) => item.id), [first.id]);
    assert.deepEqual(result.conflicts.map((conflict) => ({
      id: conflict.conflictGroupId,
      selected: conflict.selectedMemberCount,
      truncated: conflict.truncated,
    })), [{
      id: conflictGroupId,
      selected: 1,
      truncated: true,
    }]);
    assert.match(result.conflicts[0]?.cursor ?? "", /^retrieval-conflict-v1:1:/u);
    assert.equal(result.conflictTruncated, true);
    assert.equal(result.redactedDropCounts.byReason.tokenBudget, 1);
    assert.equal(result.redactedDropCounts.byReason.conflictSuppressed, 1);
    assert.equal(result.explanation?.conflicts.truncated, true);
    assert.equal(result.explanation?.dropped.byReason.tokenBudget, 1);
    assert.equal(result.explanation?.dropped.byReason.conflictSuppressed, 1);
    assert.equal(result.explanation?.channels[0]?.selectedCount, 1);
  });

  it("pins the required generation, returns only the bound project, and always closes the lease", async () => {
    let closed = 0;
    const lease = createLease(() => { closed += 1; });
    const pinCalls: Array<{ binding: ProjectBinding; requiredEventPosition: bigint; deadlineMs: number }> = [];
    const projections: ProjectionLeaseProvider = {
      async pin(binding, consistency) {
        pinCalls.push({ binding, ...consistency });
        return lease;
      },
    };
    const service = new InternalRetrievalService({
      projections,
      candidates: new SqliteRetrievalCandidateRepository(),
    });

    const result = await service.retrieve(request());

    assert.deepEqual(result.items.map((item) => item.projectId), [PROJECT_ID]);
    assert.deepEqual(result.items.map((item) => item.id), [ITEM_ID]);
    assert.deepEqual(pinCalls, [{
      binding: BINDING,
      requiredEventPosition: 12n,
      deadlineMs: 100,
    }]);
    assert.equal(result.generation, 1);
    assert.equal(result.terminalEventPosition, 12n);
    assert.equal(result.truncated, false);
    assert.equal(closed, 1);
  });

  it("plumbs source-position-aware projected feedback through the real repository into ranking", async () => {
    const lease = createLease(() => undefined);
    const database = new DatabaseSync(lease.databasePath);
    database.prepare(`
      INSERT INTO canonical_items(
        project_id, item_id, normalized_key, status, confidence, verification_method,
        valid_from, valid_to, summary, content_hash, known_from_event_position,
        source_event_position
      ) VALUES (?, ?, 'decision:feedback-peer', 'verified', 'high', 'committed-event',
                ?, NULL, 'feedback-order', ?, 8, 8)
    `).run(PROJECT_ID, FEEDBACK_PEER_ID, "2026-01-01T00:00:00.000Z", "7".repeat(64));
    const chunk = database.prepare(`
      INSERT INTO lexical_chunks(
        project_id, chunk_id, item_id, session_id, section, normalized_key, text,
        source_event_position
      ) VALUES (?, ?, ?, NULL, 'summary', ?, 'feedback-order', 8)
    `);
    chunk.run(PROJECT_ID, "chunk-feedback-negative", ITEM_ID, "decision:feedback-negative");
    chunk.run(PROJECT_ID, "chunk-feedback-positive", FEEDBACK_PEER_ID, "decision:feedback-positive");
    const feedback = database.prepare(`
      INSERT INTO retrieval_feedback(
        project_id, feedback_id, item_id, outcome, usefulness,
        source_item_event_position, source_event_position
      ) VALUES (?, ?, ?, ?, 10000, ?, ?)
    `);
    feedback.run(
      PROJECT_ID, "00000000-0000-4000-8000-000000000525", ITEM_ID,
      "accepted", 7, 9,
    );
    feedback.run(
      PROJECT_ID, "00000000-0000-4000-8000-000000000526", ITEM_ID,
      "dismissed", 8, 10,
    );
    feedback.run(
      PROJECT_ID, "00000000-0000-4000-8000-000000000527", FEEDBACK_PEER_ID,
      "accepted", 8, 11,
    );
    database.close();
    const service = new InternalRetrievalService({
      projections: { async pin() { return lease; } },
      candidates: new SqliteRetrievalCandidateRepository(),
    });

    const result = await service.retrieve(request({ query: "feedback-order" }));

    assert.deepEqual(result.items.slice(0, 2).map((item) => ({
      id: item.id,
      feedback: item.retrievalFeedbackScoreUnits,
    })), [
      { id: FEEDBACK_PEER_ID, feedback: 10_000 },
      { id: ITEM_ID, feedback: -10_000 },
    ]);
  });

  it("applies known-at before any channel can return a future-known item", async () => {
    let closed = 0;
    const lease = createLease(() => { closed += 1; });
    const projections: ProjectionLeaseProvider = { async pin() { return lease; } };
    const service = new InternalRetrievalService({
      projections,
      candidates: new SqliteRetrievalCandidateRepository(),
    });

    const result = await service.retrieve(request({ knownAt: 6n }));
    assert.equal(result.items.some((item) => item.knownFromEventPosition > 6n), false);
    assert.equal(result.items.length, 0);
    assert.equal(closed, 1);
  });

  it("rejects global and oversized requests before acquiring any projection lease", async () => {
    let pins = 0;
    const projections: ProjectionLeaseProvider = {
      async pin() {
        pins += 1;
        throw new Error("projection must not be opened");
      },
    };
    const service = new InternalRetrievalService({
      projections,
      candidates: new SqliteRetrievalCandidateRepository(),
    });

    await assert.rejects(
      () => service.retrieve(request({ includeGlobal: true })),
      (error: unknown) => error instanceof InternalRetrievalError
        && error.code === "GLOBAL_SCOPE_DENIED",
    );
    await assert.rejects(
      () => service.retrieve(request({ query: "x".repeat(RETRIEVAL_LIMITS.queryBytes + 1) })),
      (error: unknown) => error instanceof InternalRetrievalError
        && error.code === "RETRIEVAL_REQUEST_INVALID",
    );
    assert.equal(pins, 0);
  });

  it("rejects every configured numeric bound before acquiring a projection lease", async () => {
    let pins = 0;
    const service = new InternalRetrievalService({
      projections: {
        async pin() {
          pins += 1;
          throw new Error("projection must not be opened");
        },
      },
      candidates: new SqliteRetrievalCandidateRepository(),
    });
    const invalidRequests: InternalRetrievalRequest[] = [
      request({ limit: 0 }),
      request({ limit: RETRIEVAL_LIMITS.results + 1 }),
      request({ tokenBudget: 0 }),
      request({ tokenBudget: RETRIEVAL_LIMITS.tokenBudget + 1 }),
      request({ candidateLimit: 0 }),
      request({ candidateLimit: RETRIEVAL_LIMITS.candidates + 1 }),
      request({ explainByteLimit: 0 }),
      request({ explainByteLimit: RETRIEVAL_LIMITS.explainBytes + 1 }),
      request({ consistency: { requiredEventPosition: 12n, deadlineMs: -1 } }),
      request({
        consistency: {
          requiredEventPosition: 12n,
          deadlineMs: RETRIEVAL_LIMITS.deadlineMs + 1,
        },
      }),
    ];

    for (const invalid of invalidRequests) {
      await assert.rejects(
        () => service.retrieve(invalid),
        (error: unknown) => error instanceof InternalRetrievalError
          && error.code === "RETRIEVAL_REQUEST_INVALID",
      );
    }
    assert.equal(pins, 0);
  });

  it("rejects a workspace or branch manifest mismatch before collecting candidates", async () => {
    for (const manifestOverride of [
      { workspaceId: "8".repeat(64) as WorkspaceId },
      { branchRef: "refs/heads/other" },
    ]) {
      let closed = 0;
      let collections = 0;
      const lease = createLease(() => { closed += 1; });
      const mismatched: ProjectionReaderLease = Object.freeze({
        ...lease,
        manifest: Object.freeze({ ...lease.manifest, ...manifestOverride }),
      });
      const service = new InternalRetrievalService({
        projections: { async pin() { return mismatched; } },
        candidates: {
          collectEligible() {
            collections += 1;
            throw new Error("candidate collection must not run");
          },
        },
      });

      await assert.rejects(
        () => service.retrieve(request()),
        (error: unknown) => error instanceof InternalRetrievalError
          && error.code === "PROJECTION_SCOPE_MISMATCH",
      );
      assert.equal(collections, 0);
      assert.equal(closed, 1);
    }
  });
});
