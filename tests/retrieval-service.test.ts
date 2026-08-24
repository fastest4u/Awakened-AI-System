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
  type InternalRetrievalRequest,
  type ProjectionLeaseProvider,
} from "../src/orchestrator/retrieval/contracts.js";
import { InternalRetrievalService } from "../src/orchestrator/retrieval/service.js";

const PROJECT_ID = "1".repeat(64) as ProjectId;
const OTHER_PROJECT_ID = "9".repeat(64) as ProjectId;
const WORKSPACE_ID = "2".repeat(64) as WorkspaceId;
const BRANCH_SCOPE_ID = "00000000-0000-4000-8000-000000000521" as BranchScopeId;
const ITEM_ID = "00000000-0000-4000-8000-000000000522";

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

describe("internal retrieval service", () => {
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
