import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import type {
  SqliteConnection,
  SqliteDriver,
  SqliteOpenOptions,
  SqliteParams,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";
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

interface FixtureOptions {
  readonly events?: readonly PendingEvent[];
  readonly maxReplayEvents?: number;
  readonly maxReplayBytes?: number;
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
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
  const events = options.events ?? [
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
  let expectedStreamVersion = 0n;
  for (let offset = 0; offset < events.length; offset += 128) {
    const batch = events.slice(offset, offset + 128);
    const commandIndex = Math.floor(offset / 128);
    const command: AppendCommand<JsonValue> = {
      context: trustedContext(root),
      commandId: uuid(900_000 + commandIndex),
      idempotencyKey: `projection-integrity/build/${commandIndex}`,
      commandType: "RecordProjectionSources",
      correlationId: uuid(910_000 + commandIndex),
      agentId: "projection-integrity-agent",
      expectedStreamVersion,
      streamId: `session/${SESSION_ID}`,
      streamType: "session",
      events: batch,
      outbox: [],
      publicResponse: { recorded: true },
    };
    eventStore.append(command);
    expectedStreamVersion += BigInt(batch.length);
  }

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
      maxReplayEvents: options.maxReplayEvents,
      maxReplayBytes: options.maxReplayBytes,
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

function mutateFtsShadowDatabase(fixture: Fixture, sql: string): void {
  const database = new DatabaseSync(fixture.databasePath, {
    defensive: false,
  });
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

function ftsDecisionRanks(path: string): readonly Readonly<{ rowid: bigint; rank: number }>[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const query = database.prepare(`
      SELECT rowid, rank FROM lexical_chunks_fts
      WHERE lexical_chunks_fts MATCH 'decision'
      ORDER BY rowid
    `);
    query.setReadBigInts(true);
    return Object.freeze(query.all().map((row) => Object.freeze({
      rowid: row.rowid as bigint,
      rank: row.rank as number,
    })));
  } finally {
    database.close();
  }
}

function observingFullEventRows(onRow: () => void): SqliteDriver {
  return {
    open(path: string, options: SqliteOpenOptions): SqliteConnection {
      const connection = driver.open(path, options);
      return {
        exec: (sql) => connection.exec(sql),
        close: () => connection.close(),
        prepare(sql: string): SqliteStatement {
          const prepared = connection.prepare(sql);
          if (!sql.includes("payload_json, payload_hash") || !sql.includes("FROM events")) {
            return prepared;
          }
          return {
            run: (params?: SqliteParams) => prepared.run(params),
            get: (params?: SqliteParams) => prepared.get(params),
            all: (params?: SqliteParams) => prepared.all(params),
            iterate(params?: SqliteParams) {
              const source = prepared.iterate(params);
              return (function* observedRows() {
                for (const row of source) {
                  onRow();
                  yield row;
                }
              })();
            },
          };
        },
      };
    },
  };
}

describe("full projection integrity replay", () => {
  it("returns a frozen pass report only for an exact authoritative replay", async () => {
    const fixture = await createFixture();
    const sourceBefore = databaseSha256(fixture.sourcePath);
    const generationBefore = databaseSha256(fixture.databasePath);
    assert.equal(fixture.manifest.databaseSha256, generationBefore);

    const report = fixture.integrity.verify(BINDING, fixture.manifest);

    assert.deepEqual(report, { status: "passed", terminalEventPosition: "3" });
    assert.ok(Object.isFrozen(report));
    assert.equal(databaseSha256(fixture.sourcePath), sourceBefore);
    assert.equal(databaseSha256(fixture.databasePath), generationBefore);
  });

  it("replays a scale generation through the bounded linear core", async () => {
    const events = Array.from({ length: 256 }, (_, index) => pendingEvent(
      "MemorySourceRecorded",
      projectionPayload(
        uuid(20_000 + index),
        `scale:item:${index.toString().padStart(4, "0")}`,
        `Authoritative scale item ${index}.`,
      ),
    ));
    const fixture = await createFixture({ events });

    assert.deepEqual(fixture.integrity.verify(BINDING, fixture.manifest), {
      status: "passed",
      terminalEventPosition: "256",
    });
  });

  it("does not sort the full expected projection while comparing a scale generation", async () => {
    const events = Array.from({ length: 256 }, (_, index) => pendingEvent(
      "MemorySourceRecorded",
      projectionPayload(
        uuid(30_000 + index),
        `linear:item:${index.toString().padStart(4, "0")}`,
        `Linear comparison item ${index}.`,
      ),
    ));
    const fixture = await createFixture({ events });
    const nativeSort = Array.prototype.sort;
    Array.prototype.sort = function guardedSort(compareFn) {
      if (this.length >= 128) throw new Error("FULL_EXPECTED_SORT_FORBIDDEN");
      return nativeSort.call(this, compareFn) as typeof this;
    };
    try {
      assert.deepEqual(fixture.integrity.verify(BINDING, fixture.manifest), {
        status: "passed",
        terminalEventPosition: "256",
      });
    } finally {
      Array.prototype.sort = nativeSort;
    }
  });

  it("fails closed when authoritative replay exceeds its configured event bound", async () => {
    const fixture = await createFixture({ maxReplayEvents: 2 });

    expectIntegrityFailure(() => fixture.integrity.verify(BINDING, fixture.manifest));
  });

  it("fails closed when authoritative replay exceeds its configured byte bound", async () => {
    const fixture = await createFixture({ maxReplayBytes: 256 });

    expectIntegrityFailure(() => fixture.integrity.verify(BINDING, fixture.manifest));
  });

  it("rejects an oversized stored payload before a full event row reaches JavaScript", async () => {
    const fixture = await createFixture();
    const source = new DatabaseSync(fixture.sourcePath);
    try {
      source.exec(`
        DROP TRIGGER events_no_update;
        UPDATE events
        SET payload_json = '"' || hex(zeroblob(524288)) || '"'
        WHERE global_position = 1
      `);
      source.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      source.close();
    }
    let fullRowsDelivered = 0;
    const integrity = new ProjectionIntegrityService({
      driver: observingFullEventRows(() => { fullRowsDelivered += 1; }),
      eventStorePath: fixture.sourcePath,
      projectionDirectory: fixture.projectionDirectory,
    });

    expectIntegrityFailure(() => integrity.verify(BINDING, fixture.manifest));
    assert.equal(fullRowsDelivered, 0);
  });

  it("rejects a same-byte generation replacement race before opening SQLite", async () => {
    const fixture = await createFixture();
    const replacementPath = `${fixture.databasePath}.replacement`;
    const retiredPath = `${fixture.databasePath}.retired`;
    copyFileSync(fixture.databasePath, replacementPath);
    let injected = false;
    const integrity = new ProjectionIntegrityService({
      driver,
      eventStorePath: fixture.sourcePath,
      projectionDirectory: fixture.projectionDirectory,
      faultInjector: {
        hit(boundary): void {
          if (boundary !== "after-generation-identity-before-open" || injected) return;
          injected = true;
          renameSync(fixture.databasePath, retiredPath);
          renameSync(replacementPath, fixture.databasePath);
        },
      },
    });

    expectIntegrityFailure(() => integrity.verify(BINDING, fixture.manifest));
    assert.equal(injected, true);
    assert.equal(databaseSha256(fixture.databasePath), fixture.manifest.databaseSha256);
  });

  it("keeps descriptor-captured A bytes across an A-to-B-to-A generation pathname swap", async () => {
    const fixture = await createFixture();
    const originalPath = `${fixture.databasePath}.original`;
    const alternatePath = `${fixture.databasePath}.alternate`;
    copyFileSync(fixture.databasePath, alternatePath);
    mutateFtsShadowDatabase({ ...fixture, databasePath: alternatePath }, `
      UPDATE lexical_chunks_fts_docsize SET sz = X'0101' WHERE id = 1
    `);
    assert.notEqual(databaseSha256(alternatePath), fixture.manifest.databaseSha256);
    let swapped = false;
    let restored = false;
    const integrity = new ProjectionIntegrityService({
      driver,
      eventStorePath: fixture.sourcePath,
      projectionDirectory: fixture.projectionDirectory,
      faultInjector: {
        hit(boundary): void {
          if (boundary === "after-generation-identity-before-open" && !swapped) {
            renameSync(fixture.databasePath, originalPath);
            renameSync(alternatePath, fixture.databasePath);
            swapped = true;
          } else if (boundary === "after-generation-open-before-inspection" && !restored) {
            renameSync(fixture.databasePath, alternatePath);
            renameSync(originalPath, fixture.databasePath);
            restored = true;
          }
        },
      },
    });

    assert.deepEqual(integrity.verify(BINDING, fixture.manifest), {
      status: "passed",
      terminalEventPosition: "3",
    });
    assert.equal(swapped, true);
    assert.equal(restored, true);
    assert.equal(databaseSha256(fixture.databasePath), fixture.manifest.databaseSha256);
  });

  it("does not create or clean any scratch inspection pathname", async () => {
    const fixture = await createFixture();
    const boundaries: string[] = [];
    const integrity = new ProjectionIntegrityService({
      driver,
      eventStorePath: fixture.sourcePath,
      projectionDirectory: fixture.projectionDirectory,
      faultInjector: {
        hit(boundary): void {
          boundaries.push(String(boundary));
        },
      },
    });

    assert.deepEqual(integrity.verify(BINDING, fixture.manifest), {
      status: "passed",
      terminalEventPosition: "3",
    });
    assert.deepEqual(boundaries, [
      "after-generation-identity-before-open",
      "after-generation-open-before-inspection",
    ]);
  });

  it("opens the pinned byte image only through in-memory deserialization", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "orchestrator", "projections", "integrity.ts"),
      "utf8",
    );

    assert.match(source, /new DatabaseSync\(\s*":memory:"/);
    assert.match(source, /\.deserialize\(\s*deserializableImage\(pinnedImage\.bytes\)\s*\)/);
    assert.match(source, /const result = Uint8Array\.from\(bytes\)/);
    assert.equal(source.match(/openSync\(path,\s*"r"\)/g)?.length, 1);
    assert.doesNotMatch(source, /function hashGeneration\(/);
    assert.doesNotMatch(
      source,
      /PRIVATE_INSPECTION|mkdtempSync|project-memory-projection-integrity-|after-private-root-validation-before-cleanup/,
    );
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

  it("detects a dropped required retrieval index after the database hash is re-signed", async () => {
    const fixture = await createFixture();
    mutateDatabase(fixture, "DROP INDEX retrieval_feedback_item_idx");

    expectIntegrityFailure(() => fixture.integrity.verify(
      BINDING,
      resignedManifest(fixture),
    ));
  });

  it("detects persistent FTS rank configuration tampering after the database hash is re-signed", async () => {
    const fixture = await createFixture();
    mutateDatabase(fixture, `
      INSERT INTO lexical_chunks_fts(lexical_chunks_fts, rank)
      VALUES ('rank', 'bm25(10.0, 1.0)')
    `);

    expectIntegrityFailure(() => fixture.integrity.verify(
      BINDING,
      resignedManifest(fixture),
    ));
  });

  it("detects rank-sensitive FTS docsize tampering after the database hash is re-signed", async () => {
    const fixture = await createFixture();
    const before = ftsDecisionRanks(fixture.databasePath);
    assert.equal(before.length, 2);
    mutateFtsShadowDatabase(fixture, `
      UPDATE lexical_chunks_fts_docsize SET sz = X'0101' WHERE id = 1
    `);
    const after = ftsDecisionRanks(fixture.databasePath);
    assert.notDeepEqual(after, before);

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
