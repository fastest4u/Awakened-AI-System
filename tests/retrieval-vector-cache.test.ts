import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  InternalRetrievalError,
  type InternalRetrievalRequest,
  type RetrievalCandidateCollection,
  type RetrievalItem,
  type VectorCandidateChannel,
} from "../src/orchestrator/retrieval/contracts.js";
import { InternalRetrievalService } from "../src/orchestrator/retrieval/service.js";
import {
  InMemoryVectorCacheStore,
  LocalVectorCandidateChannel,
  VECTOR_CACHE_LIMITS,
  createVectorCacheManifest,
  searchVectorChannel,
  verifyVectorCacheManifest,
  type LocalVectorCacheStore,
  type LocalVectorProvider,
  type RedactedCanonicalChunk,
  type VectorCacheRowV1,
} from "../src/orchestrator/retrieval/vector-cache.js";

const PROJECT_ID = "1".repeat(64) as ProjectId;
const OTHER_PROJECT_ID = "9".repeat(64) as ProjectId;
const WORKSPACE_ID = "2".repeat(64) as WorkspaceId;
const BRANCH_SCOPE_ID = "00000000-0000-4000-8000-000000000701" as BranchScopeId;

const BINDING: ProjectBinding = Object.freeze({
  projectId: PROJECT_ID,
  vaultId: "3".repeat(64) as VaultId,
  storeId: "4".repeat(64) as StoreId,
  workspaceId: WORKSPACE_ID,
  branchScopeId: BRANCH_SCOPE_ID,
  branchRef: "refs/heads/task-7",
  sessionId: null,
});

const OTHER_BINDING: ProjectBinding = Object.freeze({
  ...BINDING,
  projectId: OTHER_PROJECT_ID,
  vaultId: "8".repeat(64) as VaultId,
  storeId: "7".repeat(64) as StoreId,
  branchScopeId: "00000000-0000-4000-8000-000000000705" as BranchScopeId,
  branchRef: "refs/heads/task-7-other-project",
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
  generation: 7,
  terminalEventPosition: "12",
  terminalEventHash: "a".repeat(64),
  databaseFile: "projections-1-7.sqlite",
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

function request(
  overrides: Partial<InternalRetrievalRequest> = {},
): InternalRetrievalRequest {
  return Object.freeze({
    binding: BINDING,
    query: "semantic decision",
    limit: 10,
    tokenBudget: 1_200,
    consistency: Object.freeze({ requiredEventPosition: 12n, deadlineMs: 100 }),
    ...overrides,
  });
}

function item(
  id: string,
  summary: string,
  overrides: Partial<RetrievalItem> = {},
): RetrievalItem {
  return Object.freeze({
    id,
    kind: "canonical",
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    branchScopeId: BRANCH_SCOPE_ID,
    branchRef: BINDING.branchRef,
    sessionId: null,
    visibility: "branch",
    status: "verified",
    confidence: "high",
    verificationMethod: "committed-event",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    knownFromEventPosition: 7n,
    sourceEventPosition: 8n,
    summary,
    normalizedKey: `decision:${id}`,
    anchor: "summary",
    freshness: "fresh",
    conflictGroupId: null,
    supersedingItemId: null,
    retrievalFeedbackScoreUnits: 0,
    ...overrides,
  });
}

const PRIMARY = item(
  "00000000-0000-4000-8000-000000000702",
  "local semantic decision",
);
const SECONDARY = item(
  "00000000-0000-4000-8000-000000000703",
  "orthogonal note",
);
const OTHER_PROJECT = item(
  "00000000-0000-4000-8000-000000000704",
  "other-project-secret",
  { projectId: OTHER_PROJECT_ID },
);

function sourceHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function chunk(value: RetrievalItem): RedactedCanonicalChunk {
  return Object.freeze({
    sourceHash: sourceHash(value.summary),
    chunkerVersion: "canonical-summary-v1",
    text: value.summary,
    item: value,
  });
}

function collection(): RetrievalCandidateCollection {
  return Object.freeze({
    channels: Object.freeze([
      Object.freeze({
        channel: "exact" as const,
        candidates: Object.freeze([
          Object.freeze({
            candidateId: "exact-primary",
            channel: "exact" as const,
            rank: 1,
            item: PRIMARY,
          }),
        ]),
      }),
      Object.freeze({
        channel: "lexical" as const,
        candidates: Object.freeze([
          Object.freeze({
            candidateId: "lexical-primary",
            channel: "lexical" as const,
            rank: 1,
            item: PRIMARY,
          }),
        ]),
      }),
    ]),
    eligibleItemCount: 1,
    droppedItemCount: 0,
    truncated: false,
    conflictGroups: Object.freeze([]),
  });
}

function lease(onClose: () => void = () => undefined): ProjectionReaderLease {
  return Object.freeze({
    manifest: MANIFEST,
    databasePath: "C:\\derived\\projections-1-7.sqlite",
    close: onClose,
  });
}

class RecordingProvider implements LocalVectorProvider {
  readonly providerId = "local-test-provider";
  readonly model = "semantic-v1";
  readonly apiKey = "provider-credential-must-not-escape";
  readonly inputs: string[] = [];
  #nextFailure: Error | undefined;

  failNext(error: Error): void {
    this.#nextFailure = error;
  }

  embed(text: string): Promise<readonly number[]> {
    this.inputs.push(text);
    const failure = this.#nextFailure;
    this.#nextFailure = undefined;
    if (failure !== undefined) return Promise.reject(failure);
    if (text === "semantic decision" || text === PRIMARY.summary) {
      return Promise.resolve(Object.freeze([1, 0]));
    }
    return Promise.resolve(Object.freeze([0, 1]));
  }
}

function service(vectorChannel?: VectorCandidateChannel): InternalRetrievalService {
  return new InternalRetrievalService({
    projections: { async pin() { return lease(); } },
    candidates: { collectEligible() { return collection(); } },
    ...(vectorChannel === undefined ? {} : { vectorChannel }),
  });
}

async function withWatchdog<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("VECTOR_DEADLINE_NOT_ENFORCED")), milliseconds);
  });
  try {
    return await Promise.race([promise, watchdog]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("optional local vector cache", () => {
  it("is disabled by default and does not invoke an installed provider", async () => {
    const provider = new RecordingProvider();
    const vectorChannel = new LocalVectorCandidateChannel({
      provider,
      chunks: { async load() { return Object.freeze([chunk(PRIMARY)]); } },
    });

    const result = await service(vectorChannel).retrieve(request());

    assert.equal(result.channels.vector.used, false);
    assert.equal(result.channels.vector.failureCode, null);
    assert.equal(result.channels.vector.candidateCount, 0);
    assert.equal(result.channels.vector.manifest, null);
    assert.deepEqual(result.items.map(({ id, projectId }) => ({ id, projectId })), [
      { id: PRIMARY.id, projectId: PROJECT_ID },
    ]);
    assert.deepEqual(provider.inputs, []);
  });

  it("removes only the vector channel when the provider is unavailable", async () => {
    const provider = new RecordingProvider();
    const vectorChannel = new LocalVectorCandidateChannel({
      provider,
      chunks: { async load() { return Object.freeze([chunk(PRIMARY), chunk(OTHER_PROJECT)]); } },
    });
    const retrieval = service(vectorChannel);
    const disabled = await retrieval.retrieve(request());
    provider.failNext(new Error("offline"));

    const fallback = await retrieval.retrieve(request({ vector: { enabled: true } }));

    assert.equal(fallback.channels.vector.used, false);
    assert.equal(fallback.channels.vector.failureCode, "PROVIDER_UNAVAILABLE");
    assert.equal(fallback.channels.vector.candidateCount, 0);
    assert.equal(fallback.channels.vector.manifest, null);
    assert.deepEqual(
      fallback.items.map((resultItem) => resultItem.projectId),
      [request().binding.projectId],
    );
    assert.deepEqual(
      fallback.items.map((resultItem) => resultItem.id),
      disabled.items.map((resultItem) => resultItem.id),
    );
    assert.equal(fallback.rankingPolicyVersion, disabled.rankingPolicyVersion);
    const redacted = JSON.stringify(fallback, (_key, value: unknown) => (
      typeof value === "bigint" ? value.toString() : value
    ));
    assert.equal(redacted.includes(provider.apiKey), false);
    assert.equal(redacted.includes(OTHER_PROJECT.summary), false);
  });

  it("filters scope before embedding, reuses bounded rows, and verifies its manifest", async () => {
    const provider = new RecordingProvider();
    const cache = new InMemoryVectorCacheStore();
    const chunks = Object.freeze([chunk(SECONDARY), chunk(OTHER_PROJECT), chunk(PRIMARY)]);
    const enabled = request({ vector: { enabled: true } });

    const first = await searchVectorChannel(provider, enabled, { chunks, cache });

    assert.equal(first.used, true);
    assert.equal(first.failureCode, null);
    assert.deepEqual(first.candidates.map((candidate) => candidate.item.id), [
      PRIMARY.id,
      SECONDARY.id,
    ]);
    assert.equal(first.candidates.every((candidate) => candidate.item.projectId === PROJECT_ID), true);
    assert.deepEqual(
      provider.inputs,
      [enabled.query, PRIMARY.summary, SECONDARY.summary],
      "eligible chunks are embedded in canonical item order, not source iteration order",
    );
    assert.equal(provider.inputs.includes(OTHER_PROJECT.summary), false);
    assert.ok(first.manifest !== null);
    assert.equal(first.manifest.rowCount, 2);
    assert.equal(first.manifest.rows.every((row) => row.dimensions === 2), true);
    assert.equal(first.manifest.rows.every((row) => row.byteLength === 16), true);
    assert.equal(first.manifest.rows.every((row) => row.providerId === provider.providerId), true);
    assert.equal(first.manifest.rows.every((row) => row.model === provider.model), true);
    assert.equal(first.manifest.rows.every((row) => row.chunkerVersion === "canonical-summary-v1"), true);
    assert.equal(first.manifest.rows.every((row) => /^[0-9a-f]{64}$/u.test(row.cacheKey)), true);
    assert.equal(first.manifest.rows.every((row) => /^[0-9a-f]{64}$/u.test(row.outputHash)), true);
    assert.equal(verifyVectorCacheManifest(first.manifest, cache.snapshot()), true);

    provider.inputs.length = 0;
    const second = await searchVectorChannel(provider, enabled, { chunks, cache });

    assert.equal(second.used, true);
    assert.deepEqual(provider.inputs, [enabled.query], "cached chunk vectors are not regenerated");
    assert.deepEqual(second.manifest, first.manifest);
    assert.equal(JSON.stringify(second.manifest).includes(provider.apiKey), false);
    assert.equal(JSON.stringify(second.manifest).includes(PRIMARY.summary), false);

    const stored = cache.snapshot();
    const firstRow = stored[0];
    assert.ok(firstRow !== undefined);
    const corruptedBytes = Uint8Array.from(firstRow.vectorBytes);
    corruptedBytes[0] = (corruptedBytes[0] ?? 0) ^ 0xff;
    const corrupted = Object.freeze([
      Object.freeze({ ...firstRow, vectorBytes: corruptedBytes }),
      ...stored.slice(1),
    ]);
    assert.equal(verifyVectorCacheManifest(first.manifest, corrupted), false);
  });

  it("does not expose cached project A row metadata in an empty project B request manifest", async () => {
    const provider = new RecordingProvider();
    const cache = new InMemoryVectorCacheStore();
    const enabled = request({ vector: { enabled: true } });
    const seeded = await searchVectorChannel(provider, enabled, {
      chunks: Object.freeze([chunk(PRIMARY)]),
      cache,
    });
    assert.equal(seeded.manifest?.rowCount, 1);

    provider.inputs.length = 0;
    const emptyOtherProject = await searchVectorChannel(
      provider,
      request({ binding: OTHER_BINDING, vector: { enabled: true } }),
      { chunks: Object.freeze([]), cache },
    );

    assert.equal(emptyOtherProject.used, true);
    assert.equal(emptyOtherProject.failureCode, null);
    assert.equal(emptyOtherProject.manifest?.rowCount, 0);
    assert.deepEqual(emptyOtherProject.manifest?.rows, []);
    assert.deepEqual(provider.inputs, [enabled.query]);
  });

  it("bounds a never-settling vector provider and returns the primary result with its lease closed", async () => {
    let providerSignal: AbortSignal | undefined;
    const provider: LocalVectorProvider = Object.freeze({
      providerId: "never-settling-provider",
      model: "blocked-v1",
      embed(_text: string, signal?: AbortSignal): Promise<readonly number[]> {
        providerSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    let closes = 0;
    const retrieval = new InternalRetrievalService({
      projections: { async pin() { return lease(() => { closes += 1; }); } },
      candidates: { collectEligible() { return collection(); } },
      vectorChannel: new LocalVectorCandidateChannel({
        provider,
        chunks: { async load() { return Object.freeze([chunk(PRIMARY)]); } },
      }),
    });

    const result = await withWatchdog(
      retrieval.retrieve(request({
        consistency: Object.freeze({ requiredEventPosition: 12n, deadlineMs: 20 }),
        vector: { enabled: true },
      })),
      1_000,
    );

    assert.equal(result.channels.vector.used, false);
    assert.equal(result.channels.vector.failureCode, "PROVIDER_UNAVAILABLE");
    assert.deepEqual(result.items.map(({ id }) => id), [PRIMARY.id]);
    assert.equal(providerSignal?.aborted, true);
    assert.equal(closes, 1);
  });

  it("rejects a misrouted alpha cache row before satisfying a beta lookup", async () => {
    const provider = new RecordingProvider();
    const sourceCache = new InMemoryVectorCacheStore();
    const enabled = request({ vector: { enabled: true } });
    const alpha = item("00000000-0000-4000-8000-000000000706", "alpha");
    const beta = item("00000000-0000-4000-8000-000000000707", "beta");
    await searchVectorChannel(provider, enabled, {
      chunks: Object.freeze([chunk(alpha)]),
      cache: sourceCache,
    });
    const alphaRow = sourceCache.snapshot()[0];
    assert.ok(alphaRow !== undefined);
    const writes: VectorCacheRowV1[] = [];
    const misroutingCache: LocalVectorCacheStore = Object.freeze({
      find() { return alphaRow; },
      put(row: VectorCacheRowV1) { writes.push(row); },
      snapshot() { return Object.freeze([...writes]); },
    });

    provider.inputs.length = 0;
    const result = await searchVectorChannel(provider, enabled, {
      chunks: Object.freeze([chunk(beta)]),
      cache: misroutingCache,
    });

    assert.equal(result.used, true);
    assert.deepEqual(provider.inputs, [enabled.query, beta.summary]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.sourceHash, sourceHash(beta.summary));
    assert.equal(result.manifest?.rowCount, 1);
    assert.equal(result.manifest?.rows[0]?.sourceHash, sourceHash(beta.summary));
  });

  it("deterministically evicts the oldest row so entry 513 can be cached", async () => {
    const provider = new RecordingProvider();
    const cache = new InMemoryVectorCacheStore();
    const stale = Object.freeze(Array.from(
      { length: VECTOR_CACHE_LIMITS.rows },
      (_unused, index) => chunk(item(`capacity-${index.toString().padStart(3, "0")}`, `stale-vector-${index}`)),
    ));
    const fill = await searchVectorChannel(
      provider,
      request({
        candidateLimit: VECTOR_CACHE_LIMITS.rows,
        consistency: Object.freeze({ requiredEventPosition: 12n, deadlineMs: 30_000 }),
        vector: { enabled: true },
      }),
      { chunks: stale, cache },
    );
    assert.equal(fill.used, true);
    assert.equal(cache.snapshot().length, VECTOR_CACHE_LIMITS.rows);

    const fresh = item("capacity-513", "fresh-vector-513");
    const result = await searchVectorChannel(
      provider,
      request({ vector: { enabled: true } }),
      { chunks: Object.freeze([chunk(fresh)]), cache },
    );
    const stored = cache.snapshot();

    assert.equal(result.used, true);
    assert.equal(result.failureCode, null);
    assert.equal(result.manifest?.rowCount, 1);
    assert.equal(result.manifest?.rows[0]?.sourceHash, sourceHash(fresh.summary));
    assert.equal(stored.length, VECTOR_CACHE_LIMITS.rows);
    assert.equal(stored.some((row) => row.sourceHash === sourceHash(fresh.summary)), true);
    assert.equal(stored.some((row) => row.sourceHash === sourceHash("stale-vector-0")), false);
  });

  it("degrades malformed or oversized provider output without persisting it", async () => {
    for (const vector of [
      Object.freeze([Number.NaN, 0]),
      Object.freeze(new Array<number>(VECTOR_CACHE_LIMITS.dimensions + 1).fill(1)),
    ]) {
      const cache = new InMemoryVectorCacheStore();
      const provider: LocalVectorProvider = Object.freeze({
        providerId: "malformed-local-provider",
        model: "bad-v1",
        async embed() { return vector; },
      });

      const result = await searchVectorChannel(
        provider,
        request({ vector: { enabled: true } }),
        { chunks: Object.freeze([chunk(PRIMARY)]), cache },
      );

      assert.equal(result.used, false);
      assert.equal(result.failureCode, "PROVIDER_UNAVAILABLE");
      assert.deepEqual(result.candidates, []);
      assert.equal(result.manifest, null);
      assert.deepEqual(cache.snapshot(), []);
    }
  });

  it("strictly validates vector opt-in before pinning a projection", async () => {
    let pins = 0;
    const retrieval = new InternalRetrievalService({
      projections: {
        async pin() {
          pins += 1;
          return lease();
        },
      },
      candidates: { collectEligible() { return collection(); } },
    });
    const invalid = [
      request({ vector: { enabled: "yes" } as unknown as { enabled: boolean } }),
      request({
        vector: { enabled: true, apiKey: "secret" } as unknown as { enabled: boolean },
      }),
    ];

    for (const input of invalid) {
      await assert.rejects(
        () => retrieval.retrieve(input),
        (error: unknown) => error instanceof InternalRetrievalError
          && error.code === "RETRIEVAL_REQUEST_INVALID",
      );
    }
    assert.equal(pins, 0);
  });

  it("keeps unmeasured vector ranking shadow-only and excludes candidates outside scope", async () => {
    const malicious: VectorCandidateChannel = Object.freeze({
      async search() {
        return Object.freeze({
          used: true,
          failureCode: null,
          candidates: Object.freeze([
            Object.freeze({
              candidateId: "vector-secondary",
              rank: 1,
              similarity: 1,
              item: SECONDARY,
            }),
            Object.freeze({
              candidateId: "vector-other-project",
              rank: 2,
              similarity: 0.9,
              item: OTHER_PROJECT,
            }),
          ]),
          manifest: createVectorCacheManifest([]),
        });
      },
    });

    const result = await service(malicious).retrieve(request({ vector: { enabled: true } }));

    assert.equal(result.channels.vector.used, true);
    assert.equal(result.channels.vector.candidateCount, 1);
    assert.deepEqual(result.items.map((resultItem) => resultItem.projectId), [PROJECT_ID]);
    assert.deepEqual(result.items.map((resultItem) => resultItem.id), [PRIMARY.id]);
  });
});
