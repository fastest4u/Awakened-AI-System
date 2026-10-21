import assert from "node:assert/strict";
import { canonicalMkdtemp } from "./support/canonical-temp.js";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
} from "node:fs";
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
import { V2ProjectionBuildCoordinator } from "../src/orchestrator/projections/coordinator.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import type { ProjectionEventSnapshot } from "../src/orchestrator/projections/event-reader.js";
import type { ProjectionManifestV1 } from "../src/orchestrator/projections/manifest.js";
import type { ProjectionReaderLease } from "../src/orchestrator/projections/reader-lease.js";
import { PROJECTION_SCHEMA_SQL_V1 } from "../src/orchestrator/projections/schema.js";
import {
  collectEligibleFromProjectionDatabase,
  SqliteRetrievalCandidateRepository,
} from "../src/orchestrator/retrieval/candidates.js";
import {
  InternalRetrievalError,
  type InternalRetrievalRequest,
  type RetrievalCandidateCollection,
} from "../src/orchestrator/retrieval/contracts.js";
import { V2SqliteRetrievalCandidateRepository } from "../src/orchestrator/retrieval/v2-candidates.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";

const PROJECT_ID = "1".repeat(64) as ProjectId;
const VAULT_ID = "2".repeat(64) as VaultId;
const STORE_ID = "3".repeat(64) as StoreId;
const WORKSPACE_ID = "4".repeat(64) as WorkspaceId;
const BRANCH_SCOPE_ID = "00000000-0000-4000-8000-000000000611" as BranchScopeId;
const BRANCH_REF = "refs/heads/v2-candidate-adapter";
const SESSION_ID = "00000000-0000-4000-8000-000000000612";
const V2_ITEM_ID = "00000000-0000-4000-8000-000000000613";
const REPLACEMENT_ITEM_ID = "00000000-0000-4000-8000-000000000614";
const V1_ITEM_ID = "00000000-0000-4000-8000-000000000615";
const NOW = "2026-08-25T04:00:00.000Z";
const driver = new NodeSqliteDriver({ DatabaseSync });

const BINDING: ProjectBinding = Object.freeze({
  projectId: PROJECT_ID,
  vaultId: VAULT_ID,
  storeId: STORE_ID,
  workspaceId: WORKSPACE_ID,
  branchScopeId: BRANCH_SCOPE_ID,
  branchRef: BRANCH_REF,
  sessionId: null,
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function request(query: string): InternalRetrievalRequest {
  return Object.freeze({
    binding: BINDING,
    query,
    limit: 10,
    tokenBudget: 1_200,
    candidateLimit: 100,
    consistency: Object.freeze({ requiredEventPosition: 1n, deadlineMs: 1_000 }),
    sessionId: SESSION_ID,
    visibility: "session",
    validAt: NOW,
    knownAt: 1n,
  });
}

function storedMemoryEvent(itemId: string, normalizedKey: string, summary: string): StoredEvent {
  const payload: JsonValue = {
    sourceVersion: 1,
    binding: { ...BINDING, sessionId: SESSION_ID },
    itemId,
    normalizedKey,
    status: "verified",
    confidence: "high",
    verificationMethod: "committed-event",
    validFrom: NOW,
    validTo: null,
    summary,
    contentHash: "a".repeat(64),
  };
  return Object.freeze({
    globalPosition: 1n,
    eventId: "00000000-0000-4000-8000-000000000616",
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    branchScopeId: BRANCH_SCOPE_ID,
    branchRef: BRANCH_REF,
    streamId: `session/${SESSION_ID}`,
    streamType: "session",
    streamVersion: 1n,
    eventType: "MemorySourceRecorded",
    eventSchemaVersion: 1,
    sessionId: SESSION_ID,
    parentSessionId: null,
    actorRole: "primary",
    agentId: "v2-candidate-adapter-test",
    clientInstanceId: "v2-candidate-adapter-client",
    correlationId: "00000000-0000-4000-8000-000000000617",
    causationId: null,
    commandId: "00000000-0000-4000-8000-000000000618",
    idempotencyKey: `v2-candidate-adapter/${itemId}`,
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
    eventHash: "b".repeat(64),
    lifecycleIntentJson: null,
  });
}

function snapshot(event: StoredEvent): ProjectionEventSnapshot {
  let streamed = false;
  return Object.freeze({
    binding: BINDING,
    eventCount: 1,
    aggregateBytes: Buffer.byteLength(event.payloadJson, "utf8"),
    terminalEventPosition: event.globalPosition,
    terminalEventHash: event.eventHash,
    events(): Iterable<StoredEvent> {
      if (streamed) throw new Error("INTEGRITY_FAILURE");
      streamed = true;
      return Object.freeze([event]);
    },
    close(): void {},
  });
}

interface V2Fixture {
  readonly coordinator: V2ProjectionBuildCoordinator;
  readonly projectionDirectory: string;
  readonly replacementDatabasePath: string;
}

async function createV2Fixture(): Promise<V2Fixture> {
  const root = canonicalMkdtemp("v2-retrieval-candidates-");
  roots.push(root);
  const projectionDirectory = join(root, "projections");
  const sourceEvent = storedMemoryEvent(
    V2_ITEM_ID,
    "decision:v2-candidate-adapter",
    "The detached V2 evaluator image returns this candidate.",
  );
  const coordinator = new V2ProjectionBuildCoordinator({
    projectionDirectory,
    eventReader: { async openCommittedSnapshot() { return snapshot(sourceEvent); } },
    builder: new ImmutableProjectionBuilder({ driver, projectionDirectory, now: () => NOW }),
    now: () => 0,
  });
  await coordinator.ensurePublished(BINDING, 1n, 1_000);

  const replacementBuilder = new ImmutableProjectionBuilder({
    driver,
    projectionDirectory: join(root, "replacement"),
    now: () => NOW,
  });
  const replacement = await replacementBuilder.buildV2(snapshot(storedMemoryEvent(
    REPLACEMENT_ITEM_ID,
    "decision:replacement-source",
    "This valid source must never be read through the V2 evaluator lease.",
  )), 1);
  return Object.freeze({
    coordinator,
    projectionDirectory,
    replacementDatabasePath: replacement.temporaryDatabasePath,
  });
}

function candidateEvidence(collection: RetrievalCandidateCollection): readonly string[] {
  return Object.freeze(collection.channels.flatMap((channel) => channel.candidates.map(
    (candidate) => `${candidate.candidateId}:${candidate.item.summary}`,
  )).sort());
}

function v1Manifest(): ProjectionManifestV1 {
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
    terminalEventPosition: "1",
    terminalEventHash: "c".repeat(64),
    databaseFile: "projections-1-1.sqlite",
    databaseSha256: "d".repeat(64),
    coreChecksums: Object.freeze({
      sessionTree: "1".repeat(64),
      canonicalItems: "2".repeat(64),
      tasksFollowups: "3".repeat(64),
      artifactsFiles: "4".repeat(64),
      entityGraph: "5".repeat(64),
      lexicalChunks: "6".repeat(64),
      retrievalFeedback: "7".repeat(64),
    }),
    createdAt: NOW,
  });
}

function createV1Lease(): ProjectionReaderLease {
  const root = canonicalMkdtemp("v1-candidate-protection-");
  roots.push(root);
  const databasePath = join(root, "projections-1-1.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(PROJECTION_SCHEMA_SQL_V1);
    database.prepare(`
      UPDATE projection_metadata SET
        project_id = ?, vault_id = ?, store_id = ?, workspace_id = ?,
        branch_scope_id = ?, branch_ref = ?, session_id = NULL, generation = 1,
        terminal_event_position = 1, terminal_event_hash = ?, created_at = ?
      WHERE singleton = 1
    `).run(
      BINDING.projectId,
      BINDING.vaultId,
      BINDING.storeId,
      BINDING.workspaceId,
      BINDING.branchScopeId,
      BINDING.branchRef,
      "c".repeat(64),
      NOW,
    );
    database.prepare(`
      INSERT INTO canonical_items(
        project_id, session_id, item_id, normalized_key, status, confidence,
        verification_method, valid_from, valid_to, summary, content_hash,
        known_from_event_position, source_event_position
      ) VALUES (?, ?, ?, ?, 'verified', 'high', 'committed-event', ?, NULL, ?, ?, 1, 1)
    `).run(
      PROJECT_ID,
      SESSION_ID,
      V1_ITEM_ID,
      "decision:v1-public-contract",
      NOW,
      "The V1 candidate repository keeps its V1 lease contract.",
      "e".repeat(64),
    );
  } finally {
    database.close();
  }
  return Object.freeze({ manifest: v1Manifest(), databasePath, close(): void {} });
}

describe("V2 evaluator retrieval candidates", () => {
  it("reads the detached V2 lease image after the published pathname changes", async () => {
    const fixture = await createV2Fixture();
    const lease = await fixture.coordinator.leasePublishedForEvaluation(BINDING);
    try {
      const repository = new V2SqliteRetrievalCandidateRepository();
      const input = request("decision:v2-candidate-adapter");
      const baselineCollection = repository.collectEligible(lease, input);
      const baseline = candidateEvidence(baselineCollection);
      assert.ok(baseline.some((candidate) => candidate.includes(V2_ITEM_ID)));
      assert.deepEqual(
        baselineCollection.channels.find((channel) => channel.channel === "alias")?.candidates,
        [],
      );
      assert.deepEqual(
        baselineCollection.channels.find((channel) => channel.channel === "session-checkpoint")?.candidates,
        [],
      );

      const finalPath = join(fixture.projectionDirectory, lease.manifest.databaseFile);
      const movedPath = `${finalPath}.original`;
      renameSync(finalPath, movedPath);
      assert.deepEqual(candidateEvidence(repository.collectEligible(lease, input)), baseline);

      copyFileSync(fixture.replacementDatabasePath, finalPath);
      assert.deepEqual(candidateEvidence(repository.collectEligible(lease, input)), baseline);

      truncateSync(finalPath, 0);
      assert.deepEqual(candidateEvidence(repository.collectEligible(lease, input)), baseline);

      const source = new DatabaseSync(movedPath);
      try {
        source.prepare("UPDATE projection_metadata SET created_at = ? WHERE singleton = 1")
          .run("2026-08-25T04:01:00.000Z");
      } finally {
        source.close();
      }
      assert.deepEqual(candidateEvidence(repository.collectEligible(lease, input)), baseline);

      assert.equal(lease.database.prepare("SELECT count(*) AS count FROM projection_metadata").get()?.count, 1);
    } finally {
      lease.close();
    }
  });

  it("maps a corrupt V2 manifest to a retrieval projection error without a pathname", async () => {
    const fixture = await createV2Fixture();
    const lease = await fixture.coordinator.leasePublishedForEvaluation(BINDING);
    try {
      const invalidLease = Object.freeze({
        manifest: { ...lease.manifest, generation: 0 } as unknown as typeof lease.manifest,
        database: lease.database,
        close: lease.close,
      });
      const finalPath = join(fixture.projectionDirectory, lease.manifest.databaseFile);
      assert.throws(
        () => new V2SqliteRetrievalCandidateRepository().collectEligible(
          invalidLease,
          request("decision:v2-candidate-adapter"),
        ),
        (error: unknown) => error instanceof InternalRetrievalError
          && error.code === "RETRIEVAL_PROJECTION_INVALID"
          && !error.message.includes(finalPath),
      );
    } finally {
      lease.close();
    }
  });

  it("keeps the V1 repository public contract bound to ProjectionReaderLease", () => {
    const repository: {
      collectEligible(lease: ProjectionReaderLease, input: InternalRetrievalRequest): RetrievalCandidateCollection;
    } = new SqliteRetrievalCandidateRepository();
    const collection = repository.collectEligible(createV1Lease(), request("decision:v1-public-contract"));

    assert.equal(typeof collectEligibleFromProjectionDatabase, "function");
    assert.deepEqual(candidateEvidence(collection), [
      "exact:canonical:00000000-0000-4000-8000-000000000615:The V1 candidate repository keeps its V1 lease contract.",
    ]);
  });

  it("keeps the V2 adapter free of pathname and database-lifecycle APIs", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "orchestrator", "retrieval", "v2-candidates.ts"),
      "utf8",
    );

    for (const prohibited of [
      /\bDatabaseSync\b/u,
      /\bdatabasePath\b/u,
      /\bopenProjection\b/u,
      /\bassertProjectionSidecarsAbsent\b/u,
      /\.close\(\)/u,
    ]) assert.doesNotMatch(source, prohibited);
  });
});
