import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, it } from "node:test";

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
const CONFLICT_ALTERNATIVE_ID = "00000000-0000-4000-8000-000000000524";
const CONFLICT_HIDDEN_ID = "00000000-0000-4000-8000-000000000525";
const CONFLICT_GROUP_ID = "00000000-0000-4000-8000-000000000526";
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

function memoryStoredEvent(options: Readonly<{
  position?: number;
  itemId?: string;
  normalizedKey?: string;
  summary?: string;
  sessionId?: string;
  status?: "verified" | "conflicted";
  conflictGroupId?: string | null;
  supersedingItemId?: string | null;
}> = {}): StoredEvent {
  const position = options.position ?? 1;
  const sessionId = options.sessionId ?? SESSION_ID;
  const sourceVersion = options.conflictGroupId === undefined
    && options.supersedingItemId === undefined ? 1 : 2;
  const payload: JsonValue = {
    sourceVersion,
    binding: { ...BINDING, sessionId },
    itemId: options.itemId ?? ITEM_ID,
    normalizedKey: options.normalizedKey ?? "decision:session-a-only",
    status: options.status ?? "verified",
    confidence: "high",
    verificationMethod: "committed-event",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    summary: options.summary ?? "Session A private decision.",
    contentHash: "e".repeat(64),
    ...(sourceVersion === 2 ? {
      conflictGroupId: options.conflictGroupId ?? null,
      supersedingItemId: options.supersedingItemId ?? null,
    } : {}),
  };
  return Object.freeze({
    globalPosition: BigInt(position),
    eventId: `00000000-0000-4000-8000-${String(520 + position).padStart(12, "0")}`,
    projectId: PROJECT_ID,
    vaultId: BINDING.vaultId,
    storeId: BINDING.storeId,
    workspaceId: WORKSPACE_ID,
    branchScopeId: BRANCH_SCOPE_ID,
    branchRef: BINDING.branchRef,
    streamId: `session/${sessionId}`,
    streamType: "session",
    streamVersion: BigInt(position),
    eventType: "MemorySourceRecorded",
    eventSchemaVersion: sourceVersion,
    sessionId,
    parentSessionId: null,
    actorRole: "primary",
    agentId: "retrieval-test-agent",
    clientInstanceId: "retrieval-test-client",
    correlationId: "00000000-0000-4000-8000-000000000522",
    causationId: null,
    commandId: "00000000-0000-4000-8000-000000000523",
    idempotencyKey: `retrieval/session-scope/${position}`,
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
    previousGlobalHash: position === 1 ? "0".repeat(64) : `${position - 1}`.repeat(64).slice(0, 64),
    eventHash: `${position}`.repeat(64).slice(0, 64),
    lifecycleIntentJson: null,
  });
}


import { collectEligibleFromProjectionDatabase as legacyCollect } from "../src/orchestrator/retrieval/candidates.js";
import { V2SqliteRetrievalCandidateRepository } from "../src/orchestrator/retrieval/v2-candidates.js";
import type { ProjectionManifestV2 } from "../src/orchestrator/projections/manifest-codec.js";
import type { V2ProjectionReaderLease } from "../src/orchestrator/projections/v2-reader-lease.js";

interface DatabaseCore {
  collectEligibleFromProjectionDatabase(
    database: DatabaseSync, manifest: ProjectionManifestV1 | ProjectionManifestV2,
    input: InternalRetrievalRequest,
  ): RetrievalCandidateCollection;
}

it("database_core_exports_and_preserves_native_and_legacy_queries", async () => {
  const modulePath = "../src/orchestrator/retrieval/database-core.js";
  const core = await import(modulePath).catch(() => ({})) as Partial<DatabaseCore>;
  assert.equal(typeof core.collectEligibleFromProjectionDatabase, "function");
  const collect = core.collectEligibleFromProjectionDatabase!;
  const lease = createLease();
  const db = new DatabaseSync(lease.databasePath);
  try {
    db.prepare(`
      INSERT INTO retrieval_feedback(project_id, feedback_id, item_id, outcome,
        usefulness, source_item_event_position, source_event_position)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(PROJECT_ID, "current-feedback", ITEM_ID, "accepted", 1200, 10, 10);
    db.prepare(`
      INSERT INTO retrieval_feedback(project_id, feedback_id, item_id, outcome,
        usefulness, source_item_event_position, source_event_position)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(PROJECT_ID, "stale-feedback", ITEM_ID, "accepted", 9000, 5, 10);
    const cases = [
      ["decision:same-task", "exact", [ITEM_ID]],
      ["same-task-alias", "alias", [ITEM_ID]],
      ["ระบบ", "lexical", [ITEM_ID]],
      ["loadSymbol", "symbol-path", ["artifact-symbol"]],
      ["checkpoint-current", "session-checkpoint", ["checkpoint-current"]],
      ["follow-up-current", "open-follow-up", ["follow-up-current"]],
      ["future-task-alias", "alias", []],
      ["loadOther", "symbol-path", []],
      ["checkpoint-other", "session-checkpoint", []],
      ["follow-up-other", "open-follow-up", []],
    ] as const;
    for (const [query, channel, ids] of cases) {
      const pureCollection = collect(db, lease.manifest, request(query));
      const legacyCollection = new SqliteRetrievalCandidateRepository().collectEligible(lease, request(query));
      assert.deepEqual(pureCollection, legacyCollection);
      assert.deepEqual(pureCollection, legacyCollect(db, lease.manifest, request(query)));
      assert.deepEqual(channelIds(pureCollection, channel), ids);
      assert.equal(pureCollection.eligibleItemCount, ids.length);
      assert.equal(pureCollection.droppedItemCount, 0);
      assert.equal(pureCollection.truncated, false);
    }
    const exact = collect(db, lease.manifest, request("decision:same-task"));
    const item = exact.channels[0]!.candidates[0]!.item;
    assert.equal(item.sourceEventPosition, 10n);
    assert.equal(item.normalizedKey, "decision:same-task");
    assert.equal(item.summary, "same task ระบบ retrieval");
    assert.equal(item.retrievalFeedbackScoreUnits, 1200);
  } finally { db.close(); }

  // Reuse the builder-owned conflict image pattern from retrieval-candidates.
  const root = mkdtempSync(join(tmpdir(), "retrieval-database-core-v2-"));
  roots.push(root);
  const events = [
    memoryStoredEvent({ position: 1, itemId: ITEM_ID, normalizedKey: "decision:closure-anchor",
      summary: "Conflict closure anchor.", status: "conflicted", conflictGroupId: CONFLICT_GROUP_ID }),
    memoryStoredEvent({ position: 2, itemId: CONFLICT_ALTERNATIVE_ID,
      normalizedKey: "decision:closure-alternative", summary: "Eligible conflicting alternative.",
      status: "conflicted", conflictGroupId: CONFLICT_GROUP_ID }),
    memoryStoredEvent({ position: 3, itemId: CONFLICT_HIDDEN_ID,
      normalizedKey: "decision:closure-hidden", summary: "Other-session conflicting alternative.",
      sessionId: OTHER_SESSION_ID, status: "conflicted", conflictGroupId: CONFLICT_GROUP_ID }),
  ];
  let streamed = false;
  const snapshot: ProjectionEventSnapshot = {
    binding: BINDING, eventCount: 3,
    aggregateBytes: events.reduce((n, event) => n + Buffer.byteLength(event.payloadJson, "utf8"), 0),
    terminalEventPosition: 3n, terminalEventHash: events[2]!.eventHash,
    events() { assert.equal(streamed, false); streamed = true; return events; }, close() {},
  };
  const generation = await new ImmutableProjectionBuilder({
    driver: new NodeSqliteDriver({ DatabaseSync }), projectionDirectory: join(root, "projections"),
    now: () => NOW,
  }).buildV2(snapshot, 1);
  const nativeDb = new DatabaseSync(generation.temporaryDatabasePath, { readOnly: true });
  try {
    const nativeLease: V2ProjectionReaderLease = {
      database: nativeDb, manifest: generation.manifest, close() {},
    };
    const input = request("decision:closure-anchor", {
      knownAt: 3n, consistency: { requiredEventPosition: 3n, deadlineMs: 100 },
    });
    const native = collect(nativeDb, generation.manifest, input);
    assert.deepEqual(native, new V2SqliteRetrievalCandidateRepository().collectEligible(nativeLease, input));
    assert.deepEqual(channelIds(native, "exact"), [ITEM_ID]);
    assert.deepEqual(channelIds(native, "alias"), []);
    assert.deepEqual(channelIds(native, "session-checkpoint"), []);
    assert.deepEqual(channelIds(native, "conflict-closure"), [ITEM_ID, CONFLICT_ALTERNATIVE_ID]);
    assert.equal(native.eligibleItemCount, 2);
    assert.equal(native.truncated, false);
    assert.deepEqual(native.conflictGroups, [{
      conflictGroupId: CONFLICT_GROUP_ID, eligibleMemberCount: 2,
      returnedMemberCount: 2, truncated: false, cursor: null,
    }]);
    const bounded = collect(nativeDb, generation.manifest, { ...input, candidateLimit: 1 });
    assert.deepEqual(channelIds(bounded, "exact"), [ITEM_ID]);
    assert.deepEqual(channelIds(bounded, "conflict-closure"), [ITEM_ID]);
    assert.equal(bounded.eligibleItemCount, 2);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.conflictGroups[0]!.returnedMemberCount, 1);
    assert.equal(bounded.conflictGroups[0]!.eligibleMemberCount, 2);
    assert.equal(typeof bounded.conflictGroups[0]!.cursor, "string");
  } finally { nativeDb.close(); }
});
