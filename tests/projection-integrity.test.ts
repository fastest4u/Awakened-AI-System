import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import type { AppendCommand, JsonValue, PendingEvent } from "../src/orchestrator/contracts/event.js";
import type {
  BranchScopeId,
  GitWorkspaceSnapshot,
  ProjectBinding as TrustedProjectBinding,
  ProjectContext,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import { ImmutableProjectionBuilder } from "../src/orchestrator/projections/builder.js";
import {
  PROJECTION_NAMES,
  projectionCoreChecksum,
  type CanonicalProjectionRow,
  type ProjectionName,
} from "../src/orchestrator/projections/checksum.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import { SqliteProjectionEventReader } from "../src/orchestrator/projections/event-reader.js";
import {
  ProjectionIntegrityService,
} from "../src/orchestrator/projections/integrity.js";
import {
  parseProjectionManifest,
  type ProjectionManifestV1,
} from "../src/orchestrator/projections/manifest.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import {
  EventStore,
  SqliteEventStoreStatements,
} from "../src/orchestrator/storage/event-store.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type { SqliteConnection } from "../src/orchestrator/storage/sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";

const PROJECT_ID = "1".repeat(64) as ProjectId;
const OTHER_PROJECT_ID = "9".repeat(64) as ProjectId;
const VAULT_ID = "2".repeat(64) as VaultId;
const STORE_ID = "3".repeat(64) as StoreId;
const WORKSPACE_ID = "4".repeat(64) as WorkspaceId;
const BRANCH_SCOPE_ID = "00000000-0000-4000-8000-000000000401" as BranchScopeId;
const BRANCH_REF = "refs/heads/projection-integrity";
const SESSION_ID = "00000000-0000-4000-8000-000000000402";
const ITEM_A = "00000000-0000-4000-8000-000000000403";
const ITEM_B = "00000000-0000-4000-8000-000000000404";
const FEEDBACK_ID = "00000000-0000-4000-8000-000000000405";
const NOW = "2026-08-23T04:00:00.000Z";
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
const connections: SqliteConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) {
    try { connection.close(); } catch { /* cleanup continues */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function uuid(index: number): string {
  return `${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function projectionPayload(itemId: string, normalizedKey: string, summary: string): JsonValue {
  return {
    sourceVersion: 1,
    binding: { ...BINDING, sessionId: SESSION_ID },
    itemId,
    normalizedKey,
    status: "verified",
    confidence: "high",
    verificationMethod: "production-event-writer",
    validFrom: NOW,
    validTo: null,
    summary,
    contentHash: createHash("sha256").update(summary, "utf8").digest("hex"),
  };
}

function pendingEvent(eventType: string, payload: JsonValue): PendingEvent {
  return {
    eventType,
    eventSchemaVersion: 1,
    occurredAt: NOW,
    visibilityScope: "project",
    sessionId: SESSION_ID,
    confidence: "high",
    verificationStatus: "verified",
    payload,
    sourceRefs: [],
    evidenceRefs: [],
    evidenceDigests: [],
  };
}

function trustedContext(root: string): ProjectContext {
  const workspace: GitWorkspaceSnapshot = {
    kind: "git",
    worktreeRoot: root,
    gitDir: join(root, ".git", "worktrees", "integrity"),
    gitCommonDir: join(root, ".git"),
    headCommit: "0123456789abcdef0123456789abcdef01234567",
    branchRef: BRANCH_REF,
    detached: false,
    workspaceId: WORKSPACE_ID,
  };
  const binding: TrustedProjectBinding = {
    projectBindingId: "projection-integrity-binding",
    generation: 1,
    contextFingerprint: "projection-integrity-context",
    source: "explicit-cli",
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "projection-integrity-tests",
    clientInstanceId: "projection-integrity-client",
    actorRole: "primary",
    projectRoot: root,
    vaultRoot: join(root, "memory"),
    descriptorPath: join(root, "memory", ".project-memory.json"),
    storeRoute: {
      kind: "git-common",
      storeRoot: join(root, ".git", "project-memory"),
      eventsPath: join(root, ".git", "project-memory", "events.sqlite"),
      storeManifestPath: join(root, ".git", "project-memory", "store.json"),
      projectionManifestPath: join(root, ".git", "project-memory", "projection.json"),
    },
    workspace,
    establishedAt: NOW,
  };
  return { binding, workspace, checkedAt: NOW };
}

const TABLES = Object.freeze({
  sessionTree: ["session_tree", ["project_id", "session_id", "checkpoint_id", "checkpoint_version", "base_event_position", "source_event_position", "occurred_at", "task_summary"], "project_id, session_id"],
  canonicalItems: ["canonical_items", ["project_id", "item_id", "normalized_key", "status", "confidence", "verification_method", "valid_from", "valid_to", "summary", "content_hash", "known_from_event_position", "source_event_position"], "project_id, item_id"],
  tasksFollowups: ["tasks_followups", ["project_id", "session_id", "follow_up_id", "status", "summary", "confidence", "source_event_position"], "project_id, follow_up_id"],
  artifactsFiles: ["artifacts_files", ["project_id", "session_id", "artifact_id", "path", "summary", "action", "content_hash", "branch_ref", "confidence", "source_event_position"], "project_id, session_id, artifact_id"],
  entityGraph: ["entity_graph", ["project_id", "edge_id", "source_entity_id", "relationship", "target_entity_id", "source_event_position"], "project_id, edge_id"],
  lexicalChunks: ["lexical_chunks", ["project_id", "chunk_id", "item_id", "session_id", "section", "normalized_key", "text", "source_event_position"], "project_id, chunk_id"],
  retrievalFeedback: ["retrieval_feedback", ["project_id", "feedback_id", "item_id", "outcome", "usefulness", "source_item_event_position", "source_event_position"], "project_id, feedback_id"],
} as const satisfies Record<ProjectionName, readonly [string, readonly string[], string]>);

const NUMBER_COLUMNS = new Set(["checkpoint_version", "usefulness"]);

function canonicalValue(value: unknown, column: string): null | number | string {
  if (value === null || typeof value === "string") return value;
  assert.ok(typeof value === "number" && Number.isSafeInteger(value));
  return NUMBER_COLUMNS.has(column) ? value : String(value);
}

function databaseSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function coreChecksum(path: string, name: ProjectionName, terminal: bigint): string {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const [table, columns, order] = TABLES[name];
    const rows = database.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${order}`)
      .all()
      .map((raw) => {
        const row: Record<string, null | number | string> = {};
        for (const column of columns) row[column] = canonicalValue(raw[column], column);
        return row as CanonicalProjectionRow;
      });
    return projectionCoreChecksum(name, 1, PROJECT_ID, terminal, rows);
  } finally {
    database.close();
  }
}

interface Fixture {
  readonly sourcePath: string;
  readonly projectionDirectory: string;
  readonly databasePath: string;
  readonly manifest: ProjectionManifestV1;
  readonly integrity: ProjectionIntegrityService;
}

async function createFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "projection-full-integrity-"));
  roots.push(root);
  const sourcePath = join(root, "events.sqlite");
  const projectionDirectory = join(root, "projections");
  const connection = driver.open(sourcePath, { mode: "create", busyTimeoutMs: 5_000 });
  connections.push(connection);
  applyCurrentProjectStoreSchema(
    connection,
    { projectId: PROJECT_ID, vaultId: VAULT_ID, storeId: STORE_ID },
    NOW,
  );

  let nextId = 600;
  const eventStore = new EventStore(
    connection,
    new SqliteEventStoreStatements(connection),
    new MaintenanceFence(),
    new BranchScopeRepository({ randomId: () => BRANCH_SCOPE_ID }),
    () => NOW,
    () => uuid(nextId++),
  );
  const events = [
    pendingEvent("MemorySourceRecorded", projectionPayload(
      ITEM_A,
      "decision:authoritative-replay",
      "Projection rows are replayed from authoritative events.",
    )),
    pendingEvent("MemorySourceRecorded", projectionPayload(
      ITEM_B,
      "decision:immutable-generation",
      "Published generations are immutable.",
    )),
    pendingEvent("RetrievalFeedbackRecorded", {
      feedbackVersion: 1,
      binding: { ...BINDING, sessionId: SESSION_ID },
      feedbackId: FEEDBACK_ID,
      itemId: ITEM_A,
      outcome: "accepted",
      usefulness: 9000,
      sourceItemEventPosition: "1",
    }),
  ];
  const command: AppendCommand<JsonValue> = {
    context: trustedContext(root),
    commandId: uuid(500),
    idempotencyKey: "projection-integrity/build/1",
    commandType: "RecordProjectionSources",
    correlationId: uuid(501),
    agentId: "projection-integrity-agent",
    expectedStreamVersion: 0n,
    streamId: `session/${SESSION_ID}`,
    streamType: "session",
    events,
    outbox: [],
    publicResponse: { recorded: true },
  };
  eventStore.append(command);

  const snapshot = await new SqliteProjectionEventReader({
    driver,
    eventStorePath: sourcePath,
  }).openCommittedSnapshot(BINDING);
  const generation = await new ImmutableProjectionBuilder({
    driver,
    projectionDirectory,
    now: () => NOW,
  }).build(snapshot, 1);
  snapshot.close();
  connection.close();
  connections.splice(connections.indexOf(connection), 1);
  return {
    sourcePath,
    projectionDirectory,
    databasePath: generation.databasePath,
    manifest: generation.manifest,
    integrity: new ProjectionIntegrityService({
      driver,
      eventStorePath: sourcePath,
      projectionDirectory,
    }),
  };
}

function mutateDatabase(fixture: Fixture, sql: string): void {
  const database = new DatabaseSync(fixture.databasePath);
  try {
    database.exec(sql);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
}

function resignedManifest(
  fixture: Fixture,
  changedChecksums: readonly ProjectionName[] = [],
): ProjectionManifestV1 {
  const terminal = BigInt(fixture.manifest.terminalEventPosition);
  const coreChecksums = { ...fixture.manifest.coreChecksums };
  for (const name of changedChecksums) {
    coreChecksums[name] = coreChecksum(fixture.databasePath, name, terminal);
  }
  return parseProjectionManifest({
    ...fixture.manifest,
    databaseSha256: databaseSha256(fixture.databasePath),
    coreChecksums,
  }, BINDING);
}

function expectIntegrityFailure(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    if (typeof error !== "object" || error === null) return false;
    const candidate = error as { code?: unknown; message?: unknown; safeMessage?: unknown };
    return candidate.code === "INTEGRITY_FAILURE"
      && typeof candidate.message === "string"
      && candidate.message.startsWith("INTEGRITY_FAILURE:")
      && candidate.safeMessage === "Lifecycle integrity verification failed";
  });
}

describe("full projection integrity replay", () => {
  it("returns a frozen pass report only for an exact authoritative replay", async () => {
    const fixture = await createFixture();
    const sourceBefore = databaseSha256(fixture.sourcePath);

    const report = fixture.integrity.verify(BINDING, fixture.manifest);

    assert.deepEqual(report, { status: "passed", terminalEventPosition: "3" });
    assert.ok(Object.isFrozen(report));
    assert.equal(databaseSha256(fixture.sourcePath), sourceBefore);
  });

  it("detects a missing derived row after outer hashes are recomputed", async () => {
    const fixture = await createFixture();
    mutateDatabase(fixture, `DELETE FROM lexical_chunks WHERE item_id = '${ITEM_A}'`);
    expectIntegrityFailure(() => fixture.integrity.verify(
      BINDING,
      resignedManifest(fixture, ["lexicalChunks"]),
    ));
  });

  it("detects an extra derived row after outer hashes are recomputed", async () => {
    const fixture = await createFixture();
    mutateDatabase(fixture, `
      INSERT INTO entity_graph(
        project_id, edge_id, source_entity_id, relationship, target_entity_id,
        source_event_position
      ) VALUES (
        '${PROJECT_ID}', 'extra-edge', 'source', 'invented', 'target', 3
      )
    `);
    expectIntegrityFailure(() => fixture.integrity.verify(
      BINDING,
      resignedManifest(fixture, ["entityGraph"]),
    ));
  });

  it("detects canonical row reordering even though logical core rows are unchanged", async () => {
    const fixture = await createFixture();
    mutateDatabase(fixture, `
      UPDATE lexical_chunks SET row_id = row_id + 100;
      UPDATE lexical_chunks SET row_id = CASE row_id WHEN 101 THEN 2 WHEN 102 THEN 1 END;
    `);
    expectIntegrityFailure(() => fixture.integrity.verify(
      BINDING,
      resignedManifest(fixture),
    ));
  });

  it("detects cross-project rows after outer hashes are recomputed", async () => {
    const fixture = await createFixture();
    mutateDatabase(fixture, `
      UPDATE canonical_items SET project_id = '${OTHER_PROJECT_ID}' WHERE item_id = '${ITEM_A}'
    `);
    expectIntegrityFailure(() => fixture.integrity.verify(
      BINDING,
      resignedManifest(fixture, ["canonicalItems"]),
    ));
  });

  it("detects noncanonical derived values after outer hashes are recomputed", async () => {
    const fixture = await createFixture();
    mutateDatabase(fixture, `
      UPDATE canonical_items SET normalized_key = 'Decision:Authoritative-Replay'
      WHERE item_id = '${ITEM_A}'
    `);
    expectIntegrityFailure(() => fixture.integrity.verify(
      BINDING,
      resignedManifest(fixture, ["canonicalItems"]),
    ));
  });

  it("detects a checksum-mismatched manifest without touching either database", async () => {
    const fixture = await createFixture();
    const sourceBefore = databaseSha256(fixture.sourcePath);
    const projectionBefore = databaseSha256(fixture.databasePath);
    const manifest = parseProjectionManifest({
      ...fixture.manifest,
      coreChecksums: {
        ...fixture.manifest.coreChecksums,
        canonicalItems: "f".repeat(64),
      },
    }, BINDING);

    expectIntegrityFailure(() => fixture.integrity.verify(BINDING, manifest));

    assert.equal(databaseSha256(fixture.sourcePath), sourceBefore);
    assert.equal(databaseSha256(fixture.databasePath), projectionBefore);
  });

  it("maps manifest scope identity mismatch to the safe integrity contract", async () => {
    const fixture = await createFixture();
    const mismatched = {
      ...fixture.manifest,
      projectId: OTHER_PROJECT_ID,
    } as ProjectionManifestV1;
    expectIntegrityFailure(() => fixture.integrity.verify(BINDING, mismatched));
  });

  it("detects projection metadata and terminal identity tampering", async () => {
    for (const sql of [
      "UPDATE projection_metadata SET generation = 2 WHERE singleton = 1",
      `UPDATE projection_metadata SET terminal_event_hash = '${"e".repeat(64)}' WHERE singleton = 1`,
    ]) {
      const fixture = await createFixture();
      mutateDatabase(fixture, sql);
      expectIntegrityFailure(() => fixture.integrity.verify(
        BINDING,
        resignedManifest(fixture),
      ));
    }
  });

  it("detects invalid derived references after outer hashes are recomputed", async () => {
    const fixture = await createFixture();
    mutateDatabase(fixture, `
      UPDATE retrieval_feedback SET item_id = '00000000-0000-4000-8000-000000000499'
      WHERE feedback_id = '${FEEDBACK_ID}'
    `);
    expectIntegrityFailure(() => fixture.integrity.verify(
      BINDING,
      resignedManifest(fixture, ["retrievalFeedback"]),
    ));
  });

  it("detects FTS index tampering even when core rows and checksums are unchanged", async () => {
    const fixture = await createFixture();
    const database = new DatabaseSync(fixture.databasePath);
    try {
      const row = database.prepare(`
        SELECT row_id, normalized_key, text FROM lexical_chunks WHERE item_id = ?
      `).get(ITEM_A);
      assert.notEqual(row, undefined);
      database.prepare(`
        INSERT INTO lexical_chunks_fts(lexical_chunks_fts, rowid, normalized_key, text)
        VALUES ('delete', ?, ?, ?)
      `).run(row!.row_id, row!.normalized_key, row!.text);
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      database.close();
    }
    expectIntegrityFailure(() => fixture.integrity.verify(
      BINDING,
      resignedManifest(fixture),
    ));
  });

  it("rejects database bytes that no longer match the published manifest", async () => {
    const fixture = await createFixture();
    mutateDatabase(fixture, `UPDATE canonical_items SET summary = 'tampered' WHERE item_id = '${ITEM_A}'`);
    expectIntegrityFailure(() => fixture.integrity.verify(BINDING, fixture.manifest));
  });
});
