import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  BranchScopeId,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import type {
  ProjectionBuildCoordinator,
  PublishedProjectionGeneration,
} from "../src/orchestrator/projections/coordinator.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import type { ProjectionManifestV1 } from "../src/orchestrator/projections/manifest.js";
import type { ProjectionReaderLease } from "../src/orchestrator/projections/reader-lease.js";
import type {
  RetrievalCandidateRepository,
  RetrievalItem,
} from "../src/orchestrator/retrieval/contracts.js";
import { InternalRetrievalService } from "../src/orchestrator/retrieval/service.js";
import { createInternalProjectionRuntime } from "../src/orchestrator/runtime/projection-runtime.js";

const BINDING: ProjectBinding = Object.freeze({
  projectId: "1".repeat(64) as ProjectId,
  vaultId: "2".repeat(64) as VaultId,
  storeId: "3".repeat(64) as StoreId,
  workspaceId: "4".repeat(64) as WorkspaceId,
  branchScopeId: "00000000-0000-4000-8000-000000000801" as BranchScopeId,
  branchRef: "refs/heads/subproject-3-runtime",
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
  generation: 7,
  terminalEventPosition: "42",
  terminalEventHash: "a".repeat(64),
  databaseFile: "projections-1-7.sqlite",
  databaseSha256: "b".repeat(64),
  coreChecksums: Object.freeze({
    sessionTree: "c".repeat(64), canonicalItems: "d".repeat(64),
    tasksFollowups: "e".repeat(64), artifactsFiles: "f".repeat(64),
    entityGraph: "1".repeat(64), lexicalChunks: "2".repeat(64),
    retrievalFeedback: "3".repeat(64),
  }),
  createdAt: "2026-08-24T00:00:00.000Z",
});

const ITEM: RetrievalItem = Object.freeze({
  id: "00000000-0000-4000-8000-000000000802",
  kind: "canonical",
  projectId: BINDING.projectId,
  workspaceId: BINDING.workspaceId,
  branchScopeId: BINDING.branchScopeId,
  branchRef: BINDING.branchRef,
  sessionId: null,
  visibility: "project",
  status: "verified",
  confidence: "high",
  verificationMethod: "committed-event",
  validFrom: "2026-01-01T00:00:00.000Z",
  validTo: null,
  knownFromEventPosition: 40n,
  sourceEventPosition: 40n,
  summary: "internal projection runtime",
  normalizedKey: "runtime:projection",
  anchor: "src/orchestrator/runtime/projection-runtime.ts",
  freshness: "fresh",
  conflictGroupId: null,
  supersedingItemId: null,
  retrievalFeedbackScoreUnits: 0,
});

const CANDIDATES: RetrievalCandidateRepository = Object.freeze({
  collectEligible() {
    return Object.freeze({
      channels: Object.freeze([Object.freeze({
        channel: "exact" as const,
        candidates: Object.freeze([Object.freeze({
          candidateId: `canonical:${ITEM.id}`,
          channel: "exact" as const,
          rank: 1,
          item: ITEM,
        })]),
      })]),
      eligibleItemCount: 1,
      droppedItemCount: 0,
      truncated: false,
      conflictGroups: Object.freeze([]),
    });
  },
});

function lease(onClose: () => void): ProjectionReaderLease {
  return Object.freeze({
    manifest: MANIFEST,
    databasePath: "projection-runtime.sqlite",
    close: onClose,
  });
}

describe("internal projection runtime seam", () => {
  it("publishes to the consistency barrier before leasing and retrieving", async () => {
    const calls: string[] = [];
    let closed = 0;
    const coordinator: ProjectionBuildCoordinator = {
      async ensurePublished(binding, requiredEventPosition, deadlineMs) {
        calls.push(`ensure:${binding.projectId}:${requiredEventPosition}:${deadlineMs}`);
        return Object.freeze({
          manifest: MANIFEST,
          projectionDirectory: "internal-projections",
          databasePath: "projection-runtime.sqlite",
          directoryIdentity: Object.freeze({
            canonicalPath: "internal-projections",
            device: "1",
            inode: "2",
          }),
        }) as PublishedProjectionGeneration;
      },
      async leasePublished(binding) {
        calls.push(`lease:${binding.projectId}`);
        return lease(() => { closed += 1; });
      },
    };
    const runtime = createInternalProjectionRuntime({ coordinator, candidates: CANDIDATES });

    const result = await runtime.retrieval.retrieve(Object.freeze({
      binding: BINDING,
      query: "runtime:projection",
      limit: 10,
      tokenBudget: 1_000,
      consistency: Object.freeze({ requiredEventPosition: 42n, deadlineMs: 250 }),
    }));

    assert.equal(runtime.coordinator, coordinator);
    assert.ok(runtime.retrieval instanceof InternalRetrievalService);
    assert.deepEqual(result.items.map((item) => item.id), [ITEM.id]);
    assert.deepEqual(calls, [
      `ensure:${BINDING.projectId}:42:250`,
      `lease:${BINDING.projectId}`,
    ]);
    assert.equal(closed, 1);
    assert.equal(Object.isFrozen(runtime), true);
    assert.equal(Object.isFrozen(runtime.projections), true);
  });

  it("does not acquire a reader lease when projection publication fails", async () => {
    let leased = 0;
    const coordinator: ProjectionBuildCoordinator = {
      async ensurePublished() { throw new Error("projection unavailable"); },
      async leasePublished() {
        leased += 1;
        return lease(() => undefined);
      },
    };
    const runtime = createInternalProjectionRuntime({ coordinator, candidates: CANDIDATES });

    await assert.rejects(
      () => runtime.retrieval.retrieve(Object.freeze({
        binding: BINDING,
        query: "runtime:projection",
        limit: 10,
        tokenBudget: 1_000,
        consistency: Object.freeze({ requiredEventPosition: 42n, deadlineMs: 250 }),
      })),
      /projection unavailable/,
    );
    assert.equal(leased, 0);
  });

  it("captures its internal dependencies when the runtime is created", async () => {
    let originalEnsures = 0;
    let replacementEnsures = 0;
    const original: ProjectionBuildCoordinator = {
      async ensurePublished() {
        originalEnsures += 1;
        return Object.freeze({
          manifest: MANIFEST,
          projectionDirectory: "internal-projections",
          databasePath: "projection-runtime.sqlite",
          directoryIdentity: Object.freeze({
            canonicalPath: "internal-projections",
            device: "1",
            inode: "2",
          }),
        }) as PublishedProjectionGeneration;
      },
      async leasePublished() { return lease(() => undefined); },
    };
    const replacement: ProjectionBuildCoordinator = {
      async ensurePublished() {
        replacementEnsures += 1;
        throw new Error("mutated dependency used");
      },
      async leasePublished() { throw new Error("mutated dependency used"); },
    };
    const dependencies: {
      coordinator: ProjectionBuildCoordinator;
      candidates: RetrievalCandidateRepository;
    } = { coordinator: original, candidates: CANDIDATES };
    const runtime = createInternalProjectionRuntime(dependencies);
    dependencies.coordinator = replacement;

    const result = await runtime.retrieval.retrieve(Object.freeze({
      binding: BINDING,
      query: "runtime:projection",
      limit: 10,
      tokenBudget: 1_000,
      consistency: Object.freeze({ requiredEventPosition: 42n, deadlineMs: 250 }),
    }));

    assert.deepEqual(result.items.map((item) => item.id), [ITEM.id]);
    assert.equal(originalEnsures, 1);
    assert.equal(replacementEnsures, 0);
  });
});
