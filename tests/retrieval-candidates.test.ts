import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import type { JsonValue, StoredEvent } from "../src/orchestrator/contracts/event.js";
import { payloadHash } from "../src/orchestrator/crypto/event-hash.js";
import type {
  BranchScopeId,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import { ImmutableProjectionBuilder } from "../src/orchestrator/projections/builder.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import type { ProjectionEventSnapshot } from "../src/orchestrator/projections/event-reader.js";
import type { ProjectionManifestV1 } from "../src/orchestrator/projections/manifest.js";
import type { ProjectionReaderLease } from "../src/orchestrator/projections/reader-lease.js";
import { PROJECTION_SCHEMA_SQL_V1 } from "../src/orchestrator/projections/schema.js";
import { SqliteRetrievalCandidateRepository } from "../src/orchestrator/retrieval/candidates.js";
import type {
  InternalRetrievalRequest,
  RetrievalCandidateCollection,
  RetrievalChannel,
} from "../src/orchestrator/retrieval/contracts.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";

const PROJECT_ID = "1".repeat(64) as ProjectId;
const OTHER_PROJECT_ID = "9".repeat(64) as ProjectId;
const WORKSPACE_ID = "2".repeat(64) as WorkspaceId;
const BRANCH_SCOPE_ID = "00000000-0000-4000-8000-000000000511" as BranchScopeId;
const SESSION_ID = "00000000-0000-4000-8000-000000000512";
const OTHER_SESSION_ID = "00000000-0000-4000-8000-000000000513";
const ITEM_ID = "00000000-0000-4000-8000-000000000514";
const FUTURE_ITEM_ID = "00000000-0000-4000-8000-000000000515";
const NOW = "2026-08-24T00:00:00.000Z";

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

function manifest(): ProjectionManifestV1 {
  return Object.freeze({
    schemaVersion: 1,
    projectId: BINDING.projectId,
    vaultId: BINDING.vaultId,
    storeId: BINDING.storeId,
    workspaceId: BINDING.workspaceId,
    branchScopeId: BINDING.branchScopeId,
    branchRef: BINDING.branchRef,
    sessionId: null,
    generation: 1,
    terminalEventPosition: "20",
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

function createLease(options: { readonly dropFts?: boolean } = {}): ProjectionReaderLease {
  const root = mkdtempSync(join(tmpdir(), "retrieval-candidates-"));
  roots.push(root);
  const databasePath = join(root, "projections-1-1.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(PROJECTION_SCHEMA_SQL_V1);
  database.prepare(`
    UPDATE projection_metadata SET
      project_id = ?, vault_id = ?, store_id = ?, workspace_id = ?,
      branch_scope_id = ?, branch_ref = ?, session_id = NULL, generation = 1,
      terminal_event_position = 20, terminal_event_hash = ?, created_at = ?
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

  const item = database.prepare(`
    INSERT INTO canonical_items(
      project_id, item_id, normalized_key, status, confidence, verification_method,
      valid_from, valid_to, summary, content_hash, known_from_event_position,
      source_event_position
    ) VALUES (?, ?, ?, ?, 'high', 'committed-event', ?, ?, ?, ?, ?, ?)
  `);
  item.run(
    PROJECT_ID, ITEM_ID, "decision:same-task", "verified",
    "2026-01-01T00:00:00.000Z", null, "same task ระบบ retrieval", "4".repeat(64), 5, 10,
  );
  item.run(
    PROJECT_ID, FUTURE_ITEM_ID, "decision:future-task", "verified",
    "2026-01-01T00:00:00.000Z", null, "future same task", "5".repeat(64), 13, 13,
  );
  item.run(
    PROJECT_ID, "00000000-0000-4000-8000-000000000516", "decision:erased", "erased-evidence",
    "2026-01-01T00:00:00.000Z", null, "same task erased", "6".repeat(64), 3, 3,
  );
  item.run(
    OTHER_PROJECT_ID, "00000000-0000-4000-8000-000000000517", "decision:cross-project", "verified",
    "2026-01-01T00:00:00.000Z", null, "same task ระบบ retrieval", "7".repeat(64), 2, 2,
  );
  item.run(
    PROJECT_ID, "00000000-0000-4000-8000-000000000518", "decision:newer-unrelated-one", "verified",
    "2026-01-01T00:00:00.000Z", null, "newer unrelated alpha", "a".repeat(64), 12, 12,
  );
  item.run(
    PROJECT_ID, "00000000-0000-4000-8000-000000000519", "decision:newer-unrelated-two", "verified",
    "2026-01-01T00:00:00.000Z", null, "newer unrelated beta", "b".repeat(64), 14, 14,
  );

  const chunk = database.prepare(`
    INSERT INTO lexical_chunks(
      project_id, chunk_id, item_id, session_id, section, normalized_key, text,
      source_event_position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  chunk.run(PROJECT_ID, "chunk-eligible", ITEM_ID, SESSION_ID, "summary", "decision:same-task", "same task ระบบ retrieval", 10);
  chunk.run(PROJECT_ID, "chunk-future", FUTURE_ITEM_ID, SESSION_ID, "summary", "decision:future-task", "future ระบบ retrieval", 13);
  chunk.run(OTHER_PROJECT_ID, "chunk-cross", "00000000-0000-4000-8000-000000000517", SESSION_ID, "summary", "decision:cross-project", "same task ระบบ retrieval", 2);
  chunk.run(PROJECT_ID, "chunk-newer-one", "00000000-0000-4000-8000-000000000518", SESSION_ID, "summary", "decision:newer-unrelated-one", "newer unrelated alpha", 12);
  chunk.run(PROJECT_ID, "chunk-newer-two", "00000000-0000-4000-8000-000000000519", SESSION_ID, "summary", "decision:newer-unrelated-two", "newer unrelated beta", 14);

  database.prepare(`
    INSERT INTO entity_graph(
      project_id, edge_id, source_entity_id, relationship, target_entity_id,
      source_event_position
    ) VALUES (?, ?, ?, 'alias', ?, ?)
  `).run(PROJECT_ID, "edge-alias", "same-task-alias", ITEM_ID, 10);
  database.prepare(`
    INSERT INTO entity_graph(
      project_id, edge_id, source_entity_id, relationship, target_entity_id,
      source_event_position
    ) VALUES (?, ?, ?, 'alias', ?, ?)
  `).run(PROJECT_ID, "edge-future", "future-task-alias", FUTURE_ITEM_ID, 13);

  const artifact = database.prepare(`
    INSERT INTO artifacts_files(
      project_id, session_id, artifact_id, path, summary, action, content_hash,
      branch_ref, confidence, source_event_position
    ) VALUES (?, ?, ?, ?, ?, 'modified', ?, ?, 'high', ?)
  `);
  artifact.run(PROJECT_ID, SESSION_ID, "artifact-symbol", "src/orchestrator/symbol.ts", "loadSymbol", "8".repeat(64), BINDING.branchRef, 9);
  artifact.run(PROJECT_ID, SESSION_ID, "artifact-other-branch", "src/orchestrator/other.ts", "loadOther", "9".repeat(64), "refs/heads/other", 9);
  artifact.run(PROJECT_ID, SESSION_ID, "artifact-newer-one", "src/newer/alpha.ts", "newer alpha", "a".repeat(64), BINDING.branchRef, 11);
  artifact.run(PROJECT_ID, SESSION_ID, "artifact-newer-two", "src/newer/beta.ts", "newer beta", "b".repeat(64), BINDING.branchRef, 12);

  database.prepare(`
    INSERT INTO session_tree(
      project_id, session_id, checkpoint_id, checkpoint_version,
      base_event_position, source_event_position, occurred_at, task_summary
    ) VALUES (?, ?, ?, 2, 4, 8, ?, ?)
  `).run(PROJECT_ID, SESSION_ID, "checkpoint-current", "2026-08-23T00:00:00.000Z", "same task checkpoint");
  database.prepare(`
    INSERT INTO session_tree(
      project_id, session_id, checkpoint_id, checkpoint_version,
      base_event_position, source_event_position, occurred_at, task_summary
    ) VALUES (?, ?, ?, 2, 4, 9, ?, ?)
  `).run(PROJECT_ID, OTHER_SESSION_ID, "checkpoint-other", "2026-08-23T00:00:00.000Z", "same task checkpoint");

  const followUp = database.prepare(`
    INSERT INTO tasks_followups(
      project_id, session_id, follow_up_id, status, summary, confidence,
      source_event_position
    ) VALUES (?, ?, ?, 'open', ?, 'high', ?)
  `);
  followUp.run(PROJECT_ID, SESSION_ID, "follow-up-current", "finish same task", 9);
  followUp.run(PROJECT_ID, OTHER_SESSION_ID, "follow-up-other", "finish same task", 10);
  if (options.dropFts === true) database.exec("DROP TABLE lexical_chunks_fts");
  database.close();

  return Object.freeze({
    manifest: manifest(),
    databasePath,
    close: () => undefined,
  });
}

function request(
  query: string,
  overrides: Partial<InternalRetrievalRequest> = {},
): InternalRetrievalRequest {
  return Object.freeze({
    binding: BINDING,
    query,
    limit: 10,
    tokenBudget: 1_200,
    candidateLimit: 100,
    consistency: Object.freeze({ requiredEventPosition: 10n, deadlineMs: 100 }),
    sessionId: SESSION_ID,
    visibility: "session",
    validAt: "2026-08-24T00:00:00.000Z",
    knownAt: 10n,
    ...overrides,
  });
}

function channelIds(
  collection: RetrievalCandidateCollection,
  channel: RetrievalChannel,
): readonly string[] {
  return collection.channels
    .find((entry) => entry.channel === channel)?.candidates.map((candidate) => candidate.item.id)
    ?? [];
}

function createCanonicalLimitLease(count: 1 | 2): ProjectionReaderLease {
  const root = mkdtempSync(join(tmpdir(), "retrieval-truncation-"));
  roots.push(root);
  const databasePath = join(root, "projections-1-1.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(PROJECTION_SCHEMA_SQL_V1);
  database.prepare(`
    UPDATE projection_metadata SET
      project_id = ?, vault_id = ?, store_id = ?, workspace_id = ?,
      branch_scope_id = ?, branch_ref = ?, session_id = NULL, generation = 1,
      terminal_event_position = 20, terminal_event_hash = ?, created_at = ?
    WHERE singleton = 1
  `).run(
    BINDING.projectId, BINDING.vaultId, BINDING.storeId, BINDING.workspaceId,
    BINDING.branchScopeId, BINDING.branchRef, "a".repeat(64), NOW,
  );
  const insert = database.prepare(`
    INSERT INTO canonical_items(
      project_id, item_id, normalized_key, status, confidence, verification_method,
      valid_from, valid_to, summary, content_hash, known_from_event_position,
      source_event_position
    ) VALUES (?, ?, ?, 'verified', 'high', 'committed-event', ?, NULL, ?, ?, ?, ?)
  `);
  insert.run(
    PROJECT_ID, ITEM_ID, "decision:limit-only", "2026-01-01T00:00:00.000Z",
    "limit-only", "c".repeat(64), 1, 1,
  );
  if (count === 2) {
    insert.run(
      PROJECT_ID, "00000000-0000-4000-8000-000000000520", ITEM_ID,
      "2026-01-01T00:00:00.000Z", "second exact identity", "d".repeat(64), 2, 2,
    );
  }
  database.close();
  return Object.freeze({ manifest: manifest(), databasePath, close: () => undefined });
}

function memoryStoredEvent(): StoredEvent {
  const payload: JsonValue = {
    sourceVersion: 1,
    binding: { ...BINDING, sessionId: SESSION_ID },
    itemId: ITEM_ID,
    normalizedKey: "decision:session-a-only",
    status: "verified",
    confidence: "high",
    verificationMethod: "committed-event",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    summary: "Session A private decision.",
    contentHash: "e".repeat(64),
  };
  return Object.freeze({
    globalPosition: 1n,
    eventId: "00000000-0000-4000-8000-000000000521",
    projectId: PROJECT_ID,
    vaultId: BINDING.vaultId,
    storeId: BINDING.storeId,
    workspaceId: WORKSPACE_ID,
    branchScopeId: BRANCH_SCOPE_ID,
    branchRef: BINDING.branchRef,
    streamId: `session/${SESSION_ID}`,
    streamType: "session",
    streamVersion: 1n,
    eventType: "MemorySourceRecorded",
    eventSchemaVersion: 1,
    sessionId: SESSION_ID,
    parentSessionId: null,
    actorRole: "primary",
    agentId: "retrieval-test-agent",
    clientInstanceId: "retrieval-test-client",
    correlationId: "00000000-0000-4000-8000-000000000522",
    causationId: null,
    commandId: "00000000-0000-4000-8000-000000000523",
    idempotencyKey: "retrieval/session-scope/1",
    commandEventIndex: 0,
    occurredAt: NOW,
    recordedAt: NOW,
    visibilityScope: "session",
    confidence: "high",
    verificationStatus: "verified",
    sourceRefs: Object.freeze([]),
    evidenceRefs: Object.freeze([]) as readonly [],
    evidenceDigests: Object.freeze([]) as readonly [],
    payload,
    payloadJson: canonicalJson(payload),
    payloadHash: payloadHash(payload),
    previousGlobalHash: "0".repeat(64),
    eventHash: "f".repeat(64),
    lifecycleIntentJson: null,
  });
}

describe("local retrieval candidate channels", () => {
  it("searches exact, alias, FTS5, symbol/path, checkpoint, and open-follow-up channels", () => {
    const lease = createLease();
    const repository = new SqliteRetrievalCandidateRepository();

    assert.equal(existsSync(`${lease.databasePath}-wal`), false);
    assert.equal(existsSync(`${lease.databasePath}-shm`), false);

    assert.deepEqual(channelIds(repository.collectEligible(lease, request("decision:same-task")), "exact"), [ITEM_ID]);
    assert.deepEqual(channelIds(repository.collectEligible(lease, request("same-task-alias")), "alias"), [ITEM_ID]);
    assert.deepEqual(channelIds(repository.collectEligible(lease, request("ระบบ")), "lexical"), [ITEM_ID]);
    assert.deepEqual(channelIds(repository.collectEligible(lease, request("loadSymbol")), "symbol-path"), ["artifact-symbol"]);
    assert.deepEqual(channelIds(repository.collectEligible(lease, request("checkpoint-current")), "session-checkpoint"), ["checkpoint-current"]);
    assert.deepEqual(channelIds(repository.collectEligible(lease, request("follow-up-current")), "open-follow-up"), ["follow-up-current"]);
    assert.equal(existsSync(`${lease.databasePath}-wal`), false);
    assert.equal(existsSync(`${lease.databasePath}-shm`), false);
  });

  it("never passes cross-project, cross-session, cross-branch, erased, or future-known rows to a channel", () => {
    const lease = createLease();
    const repository = new SqliteRetrievalCandidateRepository();

    for (const query of ["same task", "ระบบ", "future-task-alias", "loadOther", "checkpoint-other", "follow-up-other"]) {
      const collection = repository.collectEligible(lease, request(query));
      const reached = collection.channels.flatMap((channel) => channel.candidates.map((candidate) => candidate.item));
      assert.equal(reached.some((candidate) => candidate.projectId !== PROJECT_ID), false);
      assert.equal(reached.some((candidate) => candidate.id === FUTURE_ITEM_ID), false);
      assert.equal(reached.some((candidate) => candidate.status === "erased-evidence"), false);
      assert.equal(reached.some((candidate) => candidate.sessionId === OTHER_SESSION_ID), false);
      assert.equal(reached.some((candidate) => candidate.branchRef === "refs/heads/other"), false);
    }
  });

  it("applies hard filters before the bounded eligibility window", () => {
    const lease = createLease();
    const repository = new SqliteRetrievalCandidateRepository();

    assert.deepEqual(channelIds(
      repository.collectEligible(lease, request("decision:same-task", { candidateLimit: 1 })),
      "exact",
    ), [ITEM_ID]);
    assert.deepEqual(channelIds(
      repository.collectEligible(lease, request("same-task-alias", { candidateLimit: 1 })),
      "alias",
    ), [ITEM_ID]);
    assert.deepEqual(channelIds(
      repository.collectEligible(lease, request("ระบบ", { candidateLimit: 1 })),
      "lexical",
    ), [ITEM_ID]);
    assert.deepEqual(channelIds(
      repository.collectEligible(lease, request("loadSymbol", { candidateLimit: 1 })),
      "symbol-path",
    ), ["artifact-symbol"]);
    assert.deepEqual(channelIds(
      repository.collectEligible(lease, request("checkpoint-current", { candidateLimit: 1 })),
      "session-checkpoint",
    ), ["checkpoint-current"]);
    assert.deepEqual(channelIds(
      repository.collectEligible(lease, request("follow-up-current", { candidateLimit: 1 })),
      "open-follow-up",
    ), ["follow-up-current"]);
  });

  it("matches inside each bounded channel before recency limiting", () => {
    const lease = createLease();
    const repository = new SqliteRetrievalCandidateRepository();
    const bounded = { candidateLimit: 1, knownAt: 12n };

    assert.deepEqual(channelIds(
      repository.collectEligible(lease, request("decision:same-task", bounded)),
      "exact",
    ), [ITEM_ID]);
    assert.deepEqual(channelIds(
      repository.collectEligible(lease, request("ระบบ", bounded)),
      "lexical",
    ), [ITEM_ID]);
    assert.deepEqual(channelIds(
      repository.collectEligible(lease, request("loadSymbol", bounded)),
      "symbol-path",
    ), ["artifact-symbol"]);
  });

  it("reports truncation only when a channel observes a real limit-plus-one overflow", () => {
    const repository = new SqliteRetrievalCandidateRepository();

    const exactLimit = repository.collectEligible(
      createCanonicalLimitLease(1),
      request(ITEM_ID, { candidateLimit: 1, knownAt: 20n }),
    );
    assert.deepEqual(channelIds(exactLimit, "exact"), [ITEM_ID]);
    assert.equal(exactLimit.truncated, false);

    const overflow = repository.collectEligible(
      createCanonicalLimitLease(2),
      request(ITEM_ID, { candidateLimit: 1, knownAt: 20n }),
    );
    assert.equal(channelIds(overflow, "exact").length, 1);
    assert.equal(overflow.truncated, true);
  });

  it("keeps builder-projected session canonical data out of another session", async () => {
    const root = mkdtempSync(join(tmpdir(), "retrieval-builder-scope-"));
    roots.push(root);
    const event = memoryStoredEvent();
    const snapshot: ProjectionEventSnapshot = Object.freeze({
      binding: BINDING,
      events: Object.freeze([event]),
      terminalEventPosition: event.globalPosition,
      terminalEventHash: event.eventHash,
      close: () => undefined,
    });
    const generation = await new ImmutableProjectionBuilder({
      driver: new NodeSqliteDriver({ DatabaseSync }),
      projectionDirectory: join(root, "projections"),
      now: () => NOW,
    }).build(snapshot, 1);
    const lease: ProjectionReaderLease = Object.freeze({
      manifest: generation.manifest,
      databasePath: generation.databasePath,
      close: () => undefined,
    });
    const repository = new SqliteRetrievalCandidateRepository();

    assert.deepEqual(channelIds(repository.collectEligible(lease, request(
      "decision:session-a-only",
      { sessionId: OTHER_SESSION_ID, visibility: "session" },
    )), "exact"), []);
    assert.deepEqual(channelIds(repository.collectEligible(lease, request(
      "decision:session-a-only",
      { sessionId: SESSION_ID, visibility: "session" },
    )), "exact"), [ITEM_ID]);
  });

  it("fails closed instead of bypassing a missing published FTS5 index", () => {
    const lease = createLease({ dropFts: true });
    const repository = new SqliteRetrievalCandidateRepository();

    assert.throws(
      () => repository.collectEligible(lease, request("ระบบ")),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === "RETRIEVAL_PROJECTION_INVALID",
    );
  });
});
