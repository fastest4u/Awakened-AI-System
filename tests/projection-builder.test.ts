import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import type { JsonValue, StoredEvent } from "../src/orchestrator/contracts/event.js";
import { eventHash, payloadHash } from "../src/orchestrator/crypto/event-hash.js";
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
  SqliteProjectionEventReader,
  type ProjectionEventSnapshot,
} from "../src/orchestrator/projections/event-reader.js";
import { PROJECT_MEMORY_APPLICATION_ID } from "../src/orchestrator/runtime/runtime-capabilities.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { GENESIS_GLOBAL_HASH } from "../src/orchestrator/storage/event-store.js";
import type {
  SqliteConnection,
  SqliteDriver,
  SqliteOpenOptions,
  SqliteParams,
  SqliteRow,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";

const PROJECT_ID = "1".repeat(64) as ProjectId;
const VAULT_ID = "2".repeat(64) as VaultId;
const STORE_ID = "3".repeat(64) as StoreId;
const WORKSPACE_ID = "4".repeat(64) as WorkspaceId;
const BRANCH_SCOPE_ID = "00000000-0000-4000-8000-000000000041" as BranchScopeId;
const BRANCH_REF = "refs/heads/projection-builder";
const SESSION_ID = "00000000-0000-4000-8000-000000000042";
const ITEM_ID = "00000000-0000-4000-8000-000000000043";
const ROOT_SESSION_ID = "00000000-0000-4000-8000-000000000044";
const CHILD_SESSION_ID = "00000000-0000-4000-8000-000000000045";
const ENTITY_A = "00000000-0000-4000-8000-000000000046";
const ENTITY_B = "00000000-0000-4000-8000-000000000047";
const NOW = "2026-08-23T02:00:00.000Z";

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

function createSource(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA application_id = ${PROJECT_MEMORY_APPLICATION_ID};
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE project_meta(
      singleton INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      store_id TEXT NOT NULL
    ) STRICT;
    INSERT INTO project_meta VALUES (
      1, '${PROJECT_ID}', '${VAULT_ID}', '${STORE_ID}'
    );
    CREATE TABLE events(
      global_position INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      branch_scope_id TEXT,
      branch_ref TEXT,
      stream_id TEXT NOT NULL,
      stream_type TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_schema_version INTEGER NOT NULL,
      session_id TEXT,
      parent_session_id TEXT,
      actor_role TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      client_instance_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      causation_id TEXT,
      command_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      command_event_index INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      visibility_scope TEXT NOT NULL,
      confidence TEXT NOT NULL,
      verification_status TEXT NOT NULL,
      source_refs_json TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL,
      evidence_digests_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      previous_global_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      lifecycle_intent_json TEXT
    ) STRICT;
  `);
  return database;
}

function memoryPayload(): JsonValue {
  return {
    sourceVersion: 1,
    binding: { ...BINDING, sessionId: SESSION_ID },
    itemId: ITEM_ID,
    normalizedKey: "decision:immutable-projections",
    status: "verified",
    confidence: "high",
    verificationMethod: "committed-event",
    validFrom: NOW,
    validTo: null,
    summary: "Published projection generations are immutable.",
    contentHash: "a".repeat(64),
  };
}

function rootStartedPayload(): JsonValue {
  return {
    sessionKind: "root",
    ownerGeneration: 1,
    continuityKey: "projection-root",
    clientNamespace: "projection-builder-tests",
    creatingAgentId: "builder-test",
    creatingClientInstanceId: "builder-client",
    authorityCommitment: "b".repeat(64),
  };
}

function childForkedPayload(): JsonValue {
  return {
    parentSessionId: ROOT_SESSION_ID,
    assignment: {
      assignmentId: "00000000-0000-4000-8000-000000000048",
      summary: "Materialize schema V2",
      scope: "projection remediation",
    },
    rootOwnerGeneration: 1,
    directAccessEnabled: false,
    authorityCommitment: "c".repeat(64),
    sourceTransferTicketId: null,
  };
}

function childCheckpointPayload(): JsonValue {
  return {
    checkpoint: {
      checkpointVersion: 1,
      checkpointId: "00000000-0000-4000-8000-000000000049",
      sessionId: CHILD_SESSION_ID,
      parentSessionId: ROOT_SESSION_ID,
      baseEventPosition: "2",
      checkpointEventPosition: "3",
      createdAt: NOW,
      creatorAgentId: "builder-test",
      creatorClientInstanceId: "builder-client",
      taskSummary: "Materialize every V2 relation.",
      completedItems: [],
      inProgressItems: [],
      blockers: [],
      nextActions: [],
      decisions: [],
      assumptions: [],
      unresolvedConflicts: [],
      filesTouched: [],
      artifactReferences: [],
      sourceReferences: [],
      commandResults: [],
      testResults: [],
      materialClaims: [],
      sourceState: {
        sourceStateScopeVersion: 1,
        workspaceId: WORKSPACE_ID,
        branchRef: BRANCH_REF,
        headCommit: "d".repeat(40),
        dirtyWorktreeFingerprint: "e".repeat(64),
      },
      childSummaries: [],
      evidenceCoverage: {
        captureMode: "coverage-only",
        contentRetained: false,
        highestContiguousOrdinal: null,
        missingIntervals: [],
      },
    },
    baseEventPosition: "2",
    checkpointEventPosition: "3",
  };
}

function governedPayload(): JsonValue {
  const statuses = ["open", "blocked", "completed", "carried-forward", "abandoned"] as const;
  return {
    sourceVersion: 2,
    binding: { ...BINDING, sessionId: CHILD_SESSION_ID },
    item: {
      itemId: ITEM_ID,
      normalizedKey: "decision:immutable-projections",
      status: "verified",
      confidence: "high",
      verificationMethod: "governed-source",
      validFrom: NOW,
      validTo: null,
      summary: "Published projection generations are immutable.",
      contentHash: "a".repeat(64),
      conflictGroupId: null,
      supersedingItemId: null,
      anchor: "memory/items#immutable-projections",
    },
    followUps: statuses.map((status, index) => ({
      followUpId: `00000000-0000-4000-8000-${String(50 + index).padStart(12, "0")}`,
      status,
      summary: `Follow-up ${status}`,
      confidence: "high",
      anchor: index === 0 ? "memory/follow-ups#open" : null,
    })),
    artifacts: [{
      artifactId: "00000000-0000-4000-8000-000000000055",
      path: "src/orchestrator/projections/schema.ts",
      summary: "Projection schema",
      action: "modified",
      contentHash: "f".repeat(64),
      branchRef: BRANCH_REF,
      confidence: "high",
      symbol: "PROJECTION_SCHEMA_VERSION",
      commitHash: "a".repeat(64),
      heading: "Schema V2",
      anchor: null,
    }],
    entities: [
      {
        entityId: ENTITY_A,
        normalizedName: "projection schema",
        entityType: "contract",
        validFrom: NOW,
        validTo: null,
        anchor: "memory/entities#projection-schema",
      },
      {
        entityId: ENTITY_B,
        normalizedName: "integrity replay",
        entityType: "verification",
        validFrom: NOW,
        validTo: null,
        anchor: null,
      },
    ],
    aliases: [{
      aliasId: "00000000-0000-4000-8000-000000000056",
      entityId: ENTITY_A,
      normalizedAlias: "schema v2",
      validFrom: NOW,
      validTo: null,
      anchor: null,
    }],
    edges: [{
      edgeId: "00000000-0000-4000-8000-000000000057",
      sourceEntityId: ENTITY_A,
      targetEntityId: ENTITY_B,
      edgeType: "verified-by",
      validFrom: NOW,
      validTo: null,
      anchor: "memory/entities#verified-by",
    }],
  };
}

interface InsertEventOptions {
  readonly eventSchemaVersion?: number;
  readonly sessionId?: string;
  readonly parentSessionId?: string | null;
  readonly streamVersion?: number;
  readonly visibilityScope?: "session" | "workspace" | "branch" | "project";
}

function insertEvent(
  database: DatabaseSync,
  position: number,
  eventType = "IgnoredEvent",
  payload: JsonValue = {},
  options: InsertEventOptions = {},
): void {
  const eventId = `00000000-0000-4000-8000-${String(position).padStart(12, "0")}`;
  const commandId = `00000000-0000-4000-9000-${String(position).padStart(12, "0")}`;
  const payloadJson = canonicalJson(payload);
  const hashedPayload = payloadHash(payload);
  const previousGlobalHash = position === 1
    ? GENESIS_GLOBAL_HASH
    : database.prepare("SELECT event_hash FROM events WHERE global_position = ?").get(position - 1)?.event_hash;
  if (typeof previousGlobalHash !== "string") throw new Error("missing predecessor fixture hash");
  const sessionId = options.sessionId ?? SESSION_ID;
  const parentSessionId = options.parentSessionId ?? null;
  const streamVersion = options.streamVersion ?? position;
  const eventSchemaVersion = options.eventSchemaVersion ?? 1;
  const visibilityScope = options.visibilityScope ?? "session";
  const hashMaterial = {
    globalPosition: String(position),
    eventId,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    branchScopeId: BRANCH_SCOPE_ID,
    branchRef: BRANCH_REF,
    streamId: `session/${sessionId}`,
    streamType: "session",
    streamVersion: String(streamVersion),
    eventType,
    eventSchemaVersion,
    sessionId,
    parentSessionId,
    actorRole: "primary",
    agentId: "builder-test",
    clientInstanceId: "builder-client",
    correlationId: `00000000-0000-4000-a000-${String(position).padStart(12, "0")}`,
    causationId: null,
    commandId,
    idempotencyKey: `builder/${position}`,
    commandEventIndex: 0,
    occurredAt: NOW,
    recordedAt: NOW,
    visibilityScope,
    confidence: "high",
    verificationStatus: "verified",
    sourceRefs: [],
    evidenceRefs: [],
    evidenceDigests: [],
    payloadHash: hashedPayload,
    previousGlobalHash,
  };
  database.prepare(`
    INSERT INTO events(
      global_position, event_id, project_id, vault_id, store_id, workspace_id,
      branch_scope_id, branch_ref, stream_id, stream_type, stream_version,
      event_type, event_schema_version, session_id, parent_session_id, actor_role,
      agent_id, client_instance_id, correlation_id, causation_id, command_id,
      idempotency_key, command_event_index, occurred_at, recorded_at, visibility_scope,
      confidence, verification_status, source_refs_json, evidence_refs_json,
      evidence_digests_json, payload_json, payload_hash, previous_global_hash,
      event_hash, lifecycle_intent_json
    ) VALUES (
      $globalPosition, $eventId, $projectId, $vaultId, $storeId, $workspaceId,
      $branchScopeId, $branchRef, $streamId, 'session', $streamVersion,
      $eventType, $eventSchemaVersion, $sessionId, $parentSessionId, 'primary',
      'builder-test', 'builder-client', $correlationId, NULL, $commandId,
      $idempotencyKey, 0, $occurredAt, $recordedAt, $visibilityScope,
      'high', 'verified', '[]', '[]', '[]', $payloadJson, $payloadHash,
      $previousGlobalHash, $eventHash, NULL
    )
  `).run({
    $globalPosition: position,
    $eventId: eventId,
    $projectId: PROJECT_ID,
    $vaultId: VAULT_ID,
    $storeId: STORE_ID,
    $workspaceId: WORKSPACE_ID,
    $branchScopeId: BRANCH_SCOPE_ID,
    $branchRef: BRANCH_REF,
    $streamId: `session/${sessionId}`,
    $streamVersion: streamVersion,
    $eventType: eventType,
    $eventSchemaVersion: eventSchemaVersion,
    $sessionId: sessionId,
    $parentSessionId: parentSessionId,
    $correlationId: `00000000-0000-4000-a000-${String(position).padStart(12, "0")}`,
    $commandId: commandId,
    $idempotencyKey: `builder/${position}`,
    $occurredAt: NOW,
    $recordedAt: NOW,
    $visibilityScope: visibilityScope,
    $payloadJson: payloadJson,
    $payloadHash: hashedPayload,
    $previousGlobalHash: previousGlobalHash,
    $eventHash: eventHash(hashMaterial),
  });
}

type StreamingSnapshot = Omit<ProjectionEventSnapshot, "events"> & {
  readonly eventCount: number;
  readonly aggregateBytes: number;
  events(): Iterable<StoredEvent>;
};

function streamingSnapshot(snapshot: ProjectionEventSnapshot): StreamingSnapshot {
  return snapshot as unknown as StreamingSnapshot;
}

function inertStatement(options: {
  readonly get?: () => SqliteRow | undefined;
  readonly all?: () => SqliteRow[];
  readonly iterate?: () => IterableIterator<SqliteRow>;
}): SqliteStatement {
  return {
    run(): { changes: bigint; lastInsertRowid: bigint } {
      throw new Error("unexpected run");
    },
    get(): SqliteRow | undefined {
      return options.get?.();
    },
    all(): SqliteRow[] {
      return options.all?.() ?? [];
    },
    iterate(): IterableIterator<SqliteRow> {
      return options.iterate?.() ?? [][Symbol.iterator]();
    },
  };
}

function readerForPreflight(bounds: {
  readonly eventCount: number;
  readonly aggregateBytes: number;
}): Readonly<{
  reader: SqliteProjectionEventReader;
  observations: { fullRowReads: number; closes: number; rollbacks: number };
}> {
  const observations = { fullRowReads: 0, closes: 0, rollbacks: 0 };
  const driver: SqliteDriver = {
    open(): SqliteConnection {
      return {
        exec(sql): void {
          if (sql.trim().toUpperCase() === "ROLLBACK") observations.rollbacks += 1;
        },
        close(): void {
          observations.closes += 1;
        },
        prepare(sql): SqliteStatement {
          if (sql.includes("FROM project_meta")) {
            return inertStatement({
              get: () => ({ project_id: PROJECT_ID, vault_id: VAULT_ID, store_id: STORE_ID }),
            });
          }
          if (sql.includes("ORDER BY global_position DESC")) {
            return inertStatement({
              get: () => bounds.eventCount === 0 ? undefined : {
                global_position: BigInt(bounds.eventCount),
                event_hash: "a".repeat(64),
              },
            });
          }
          if (sql.includes("event_count") && sql.includes("aggregate_bytes")) {
            return inertStatement({
              get: () => ({
                event_count: BigInt(bounds.eventCount),
                maximum_row_bytes: 1n,
                aggregate_bytes: BigInt(bounds.aggregateBytes),
              }),
            });
          }
          if (sql.includes("FROM events")) {
            return inertStatement({
              all: () => {
                observations.fullRowReads += 1;
                return [];
              },
              iterate: () => (function* rows(): IterableIterator<SqliteRow> {
                observations.fullRowReads += 1;
              })(),
            });
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
      };
    },
  };
  return Object.freeze({
    reader: new SqliteProjectionEventReader({ driver, eventStorePath: "preflight.sqlite" }),
    observations,
  });
}

function terminalTamperingDriver(): SqliteDriver {
  const delegate = new NodeSqliteDriver({ DatabaseSync });
  return {
    open(path: string, options: SqliteOpenOptions): SqliteConnection {
      const connection = delegate.open(path, options);
      return {
        exec: (sql) => connection.exec(sql),
        close: () => connection.close(),
        prepare(sql: string): SqliteStatement {
          const statement = connection.prepare(sql);
          if (!sql.includes("ORDER BY global_position DESC")) return statement;
          return {
            run: (params?: SqliteParams) => statement.run(params),
            all: (params?: SqliteParams) => statement.all(params),
            iterate: (params?: SqliteParams) => statement.iterate(params),
            get(params?: SqliteParams): SqliteRow | undefined {
              const row = statement.get(params);
              return row === undefined ? undefined : { ...row, event_hash: "f".repeat(64) };
            },
          };
        },
      };
    },
  };
}

class RecordingDriver implements SqliteDriver {
  readonly opens: Array<{ path: string; options: SqliteOpenOptions }> = [];
  readonly #delegate = new NodeSqliteDriver({ DatabaseSync });

  constructor(
    readonly afterPopulation?: (connection: SqliteConnection) => void,
    readonly afterCreateClose?: (path: string) => void,
  ) {}

  open(path: string, options: SqliteOpenOptions): SqliteConnection {
    this.opens.push({ path, options: { ...options } });
    const connection = this.#delegate.open(path, options);
    if (
      options.mode !== "create"
      || (this.afterPopulation === undefined && this.afterCreateClose === undefined)
    ) return connection;
    let commits = 0;
    let closed = false;
    return {
      exec: (sql): void => {
        connection.exec(sql);
        if (sql.trim().toUpperCase() !== "COMMIT") return;
        commits += 1;
        if (commits === 2) this.afterPopulation?.(connection);
      },
      prepare: (sql) => connection.prepare(sql),
      close: () => {
        connection.close();
        if (closed) return;
        closed = true;
        this.afterCreateClose?.(path);
      },
    };
  }
}

describe("projection generation builder", () => {
  it("reads one committed source snapshot and builds an independent immutable generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-builder-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = createSource(sourcePath);
    for (let position = 1; position < 8; position += 1) insertEvent(source, position);
    insertEvent(source, 8, "MemorySourceRecorded", memoryPayload());

    source.exec("BEGIN IMMEDIATE");
    insertEvent(source, 9);

    const driver = new RecordingDriver();
    const reader = new SqliteProjectionEventReader({
      driver,
      eventStorePath: sourcePath,
    });
    const snapshot = await reader.openCommittedSnapshot(BINDING);
    assert.equal(snapshot.terminalEventPosition, 8n);
    assert.equal(streamingSnapshot(snapshot).eventCount, 8);
    assert.ok(streamingSnapshot(snapshot).aggregateBytes > 0);
    const expectedTerminalHash = snapshot.terminalEventHash;

    const builder = new ImmutableProjectionBuilder({
      driver,
      projectionDirectory,
      now: () => NOW,
    });
    const generation = await builder.buildV2(snapshot, 1);
    snapshot.close();

    assert.equal(generation.manifest.schemaVersion, 2);
    assert.equal(generation.manifest.databaseFile, "projections-2-1.sqlite");
    assert.equal(generation.manifest.terminalEventPosition, "8");
    assert.equal(generation.manifest.sessionId, null);
    assert.deepEqual(
      {
        projectId: generation.manifest.projectId,
        vaultId: generation.manifest.vaultId,
        storeId: generation.manifest.storeId,
        workspaceId: generation.manifest.workspaceId,
        branchScopeId: generation.manifest.branchScopeId,
        branchRef: generation.manifest.branchRef,
      },
      {
        projectId: PROJECT_ID,
        vaultId: VAULT_ID,
        storeId: STORE_ID,
        workspaceId: WORKSPACE_ID,
        branchScopeId: BRANCH_SCOPE_ID,
        branchRef: BRANCH_REF,
      },
    );
    assert.equal(existsSync(generation.databasePath), true);
    assert.equal(existsSync(`${generation.databasePath}-wal`), false);
    assert.equal(existsSync(`${generation.databasePath}-shm`), false);
    assert.deepEqual(
      [...readFileSync(generation.databasePath).subarray(18, 20)],
      [1, 1],
      "published main image must use rollback journaling, not WAL header bytes",
    );
    assert.match(generation.manifest.databaseSha256, /^[0-9a-f]{64}$/u);

    source.exec("ROLLBACK");
    assert.equal(source.prepare("SELECT count(*) AS n FROM events").get()?.n, 8);
    source.close();

    const projected = new DatabaseSync(generation.databasePath, { readOnly: true });
    assert.equal(existsSync(`${generation.databasePath}-wal`), false);
    assert.equal(existsSync(`${generation.databasePath}-shm`), false);
    assert.deepEqual(
      projected.prepare("PRAGMA database_list").all().map((row) => row.name),
      ["main"],
    );
    assert.deepEqual(
      { ...projected.prepare(`
        SELECT terminal_event_position, terminal_event_hash, session_id
        FROM projection_metadata WHERE singleton = 1
      `).get() },
      {
        terminal_event_position: 8,
        terminal_event_hash: expectedTerminalHash,
        session_id: null,
      },
    );
    assert.deepEqual(
      { ...projected.prepare(`
        SELECT session_id, item_id, normalized_key, summary, source_event_position
        FROM canonical_items
      `).get() },
      {
        session_id: SESSION_ID,
        item_id: ITEM_ID,
        normalized_key: "decision:immutable-projections",
        summary: "Published projection generations are immutable.",
        source_event_position: 8,
      },
    );
    projected.close();
    assert.equal(existsSync(`${generation.databasePath}-wal`), false);
    assert.equal(existsSync(`${generation.databasePath}-shm`), false);

    assert.deepEqual(
      driver.opens.map((entry) => [entry.path, entry.options.mode]),
      [
        [sourcePath, "read-only-existing"],
        [join(projectionDirectory, ".projections-2-1.sqlite.tmp"), "create"],
      ],
    );
  });

  it("keeps the production V1 build on its historical standalone latest-checkpoint fold", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-builder-v1-boundary-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = createSource(sourcePath);
    insertEvent(source, 1);
    insertEvent(source, 2);
    insertEvent(source, 3, "SessionCheckpointRecorded", childCheckpointPayload(), {
      sessionId: CHILD_SESSION_ID,
      parentSessionId: ROOT_SESSION_ID,
      streamVersion: 1,
    });

    const snapshot = await new SqliteProjectionEventReader({
      driver: new NodeSqliteDriver({ DatabaseSync }),
      eventStorePath: sourcePath,
    }).openCommittedSnapshot(BINDING);
    const generation = await new ImmutableProjectionBuilder({
      driver: new NodeSqliteDriver({ DatabaseSync }),
      projectionDirectory,
      now: () => NOW,
    }).build(snapshot, 1);
    snapshot.close();
    source.close();

    assert.equal(generation.manifest.schemaVersion, 1);
    assert.equal(generation.manifest.databaseFile, "projections-1-1.sqlite");
    const projected = new DatabaseSync(generation.databasePath, { readOnly: true });
    try {
      assert.deepEqual({ ...projected.prepare(`
        SELECT session_id, checkpoint_id, source_event_position
        FROM session_tree
      `).get() }, {
        session_id: CHILD_SESSION_ID,
        checkpoint_id: "00000000-0000-4000-8000-000000000049",
        source_event_position: 3,
      });
    } finally {
      projected.close();
    }
  });

  it("keeps governed schema-3 material out of the production V1 build", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-builder-v1-governed-boundary-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = createSource(sourcePath);
    insertEvent(source, 1, "MemorySourceRecorded", governedPayload(), {
      eventSchemaVersion: 3,
      sessionId: CHILD_SESSION_ID,
      parentSessionId: ROOT_SESSION_ID,
      streamVersion: 1,
      visibilityScope: "project",
    });

    const snapshot = await new SqliteProjectionEventReader({
      driver: new NodeSqliteDriver({ DatabaseSync }),
      eventStorePath: sourcePath,
    }).openCommittedSnapshot(BINDING);
    const builder = new ImmutableProjectionBuilder({
      driver: new NodeSqliteDriver({ DatabaseSync }),
      projectionDirectory,
      now: () => NOW,
    });

    await assert.rejects(() => builder.build(snapshot, 1), /INTEGRITY_FAILURE/u);
    assert.equal(existsSync(join(projectionDirectory, "projections-1-1.sqlite")), false);
    snapshot.close();
    source.close();
  });

  it("builds a production-decodable root/child/checkpoint and every governed V2 relation", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-builder-v2-relations-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = createSource(sourcePath);
    insertEvent(source, 1, "SessionStarted", rootStartedPayload(), {
      sessionId: ROOT_SESSION_ID,
      parentSessionId: null,
      streamVersion: 1,
    });
    insertEvent(source, 2, "SessionForked", childForkedPayload(), {
      sessionId: CHILD_SESSION_ID,
      parentSessionId: ROOT_SESSION_ID,
      streamVersion: 1,
    });
    insertEvent(source, 3, "SessionCheckpointRecorded", childCheckpointPayload(), {
      sessionId: CHILD_SESSION_ID,
      parentSessionId: ROOT_SESSION_ID,
      streamVersion: 2,
    });
    insertEvent(source, 4, "MemorySourceRecorded", governedPayload(), {
      eventSchemaVersion: 3,
      sessionId: CHILD_SESSION_ID,
      parentSessionId: ROOT_SESSION_ID,
      streamVersion: 3,
      visibilityScope: "project",
    });

    const snapshot = await new SqliteProjectionEventReader({
      driver: new NodeSqliteDriver({ DatabaseSync }),
      eventStorePath: sourcePath,
    }).openCommittedSnapshot(BINDING);
    const generation = await new ImmutableProjectionBuilder({
      driver: new NodeSqliteDriver({ DatabaseSync }),
      projectionDirectory,
      now: () => NOW,
    }).buildV2(snapshot, 1);
    snapshot.close();
    source.close();

    const projected = new DatabaseSync(generation.databasePath, { readOnly: true });
    try {
      assert.deepEqual(projected.prepare(`
        SELECT session_id, root_session_id, parent_session_id, lifecycle_state,
               owner_generation, source_event_id
        FROM session_tree ORDER BY opened_event_position
      `).all().map((row) => ({ ...row })), [
        {
          session_id: ROOT_SESSION_ID,
          root_session_id: ROOT_SESSION_ID,
          parent_session_id: null,
          lifecycle_state: "open",
          owner_generation: 1,
          source_event_id: "00000000-0000-4000-8000-000000000001",
        },
        {
          session_id: CHILD_SESSION_ID,
          root_session_id: ROOT_SESSION_ID,
          parent_session_id: ROOT_SESSION_ID,
          lifecycle_state: "open",
          owner_generation: 1,
          source_event_id: "00000000-0000-4000-8000-000000000002",
        },
      ]);
      assert.deepEqual({ ...projected.prepare(`
        SELECT checkpoint_id, source_event_id, source_event_position, anchor
        FROM session_checkpoints
      `).get() }, {
        checkpoint_id: "00000000-0000-4000-8000-000000000049",
        source_event_id: "00000000-0000-4000-8000-000000000003",
        source_event_position: 3,
        anchor: null,
      });
      assert.deepEqual(projected.prepare(`
        SELECT status, source_event_id, anchor
        FROM tasks_followups ORDER BY follow_up_id
      `).all().map((row) => ({ ...row })), [
        { status: "open", source_event_id: "00000000-0000-4000-8000-000000000004", anchor: "memory/follow-ups#open" },
        { status: "blocked", source_event_id: "00000000-0000-4000-8000-000000000004", anchor: null },
        { status: "completed", source_event_id: "00000000-0000-4000-8000-000000000004", anchor: null },
        { status: "carried-forward", source_event_id: "00000000-0000-4000-8000-000000000004", anchor: null },
        { status: "abandoned", source_event_id: "00000000-0000-4000-8000-000000000004", anchor: null },
      ]);
      assert.deepEqual({ ...projected.prepare(`
        SELECT symbol, commit_hash, heading, source_event_id, anchor
        FROM artifacts_files
      `).get() }, {
        symbol: "PROJECTION_SCHEMA_VERSION",
        commit_hash: "a".repeat(64),
        heading: "Schema V2",
        source_event_id: "00000000-0000-4000-8000-000000000004",
        anchor: null,
      });
      assert.equal(projected.prepare("SELECT count(*) AS n FROM entity_nodes").get()?.n, 2);
      assert.deepEqual({ ...projected.prepare(`
        SELECT entity_id, normalized_alias, source_event_id, anchor FROM entity_aliases
      `).get() }, {
        entity_id: ENTITY_A,
        normalized_alias: "schema v2",
        source_event_id: "00000000-0000-4000-8000-000000000004",
        anchor: null,
      });
      assert.deepEqual({ ...projected.prepare(`
        SELECT source_entity_id, target_entity_id, edge_type, source_event_id, anchor
        FROM entity_edges
      `).get() }, {
        source_entity_id: ENTITY_A,
        target_entity_id: ENTITY_B,
        edge_type: "verified-by",
        source_event_id: "00000000-0000-4000-8000-000000000004",
        anchor: "memory/entities#verified-by",
      });
      assert.deepEqual({ ...projected.prepare(`
        SELECT source_event_id, anchor FROM canonical_items WHERE item_id = ?
      `).get(ITEM_ID) }, {
        source_event_id: "00000000-0000-4000-8000-000000000004",
        anchor: "memory/items#immutable-projections",
      });
      assert.deepEqual({ ...projected.prepare(`
        SELECT source_event_id, anchor FROM lexical_chunks WHERE item_id = ?
      `).get(ITEM_ID) }, {
        source_event_id: "00000000-0000-4000-8000-000000000004",
        anchor: "memory/items#immutable-projections",
      });
    } finally {
      projected.close();
    }
  });

  it("rejects an over-limit prefix before reading a full event row", async () => {
    const fixture = readerForPreflight({ eventCount: 100_001, aggregateBytes: 1 });

    await assert.rejects(
      () => fixture.reader.openCommittedSnapshot(BINDING),
      /INTEGRITY_FAILURE/u,
    );
    assert.equal(fixture.observations.fullRowReads, 0);
    assert.equal(fixture.observations.rollbacks, 1);
    assert.equal(fixture.observations.closes, 1);
  });

  it("rejects aggregate full-row byte overflow before reading a full event row", async () => {
    const fixture = readerForPreflight({
      eventCount: 1,
      aggregateBytes: (64 * 1024 * 1024) + 1,
    });

    await assert.rejects(
      () => fixture.reader.openCommittedSnapshot(BINDING),
      /INTEGRITY_FAILURE/u,
    );
    assert.equal(fixture.observations.fullRowReads, 0);
    assert.equal(fixture.observations.closes, 1);
  });

  it("streams authenticated events in ascending order exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-streaming-reader-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const source = createSource(sourcePath);
    for (let position = 1; position <= 3; position += 1) insertEvent(source, position);
    const snapshot = streamingSnapshot(await new SqliteProjectionEventReader({
      driver: new NodeSqliteDriver({ DatabaseSync }),
      eventStorePath: sourcePath,
    }).openCommittedSnapshot(BINDING));

    assert.equal(snapshot.eventCount, 3);
    assert.deepEqual(
      [...snapshot.events()].map((event) => event.globalPosition),
      [1n, 2n, 3n],
    );
    assert.throws(() => snapshot.events(), /INTEGRITY_FAILURE/u);
    snapshot.close();
    source.close();
  });

  it("rejects metadata tamper before a projection event is folded", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-source-metadata-tamper-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = createSource(sourcePath);
    insertEvent(source, 1, "MemorySourceRecorded", memoryPayload());
    source.prepare("UPDATE events SET agent_id = 'forged-agent' WHERE global_position = 1").run();
    const snapshot = await new SqliteProjectionEventReader({
      driver: new NodeSqliteDriver({ DatabaseSync }),
      eventStorePath: sourcePath,
    }).openCommittedSnapshot(BINDING);
    const builder = new ImmutableProjectionBuilder({
      driver: new NodeSqliteDriver({ DatabaseSync }),
      projectionDirectory,
      now: () => NOW,
    });

    await assert.rejects(() => builder.buildV2(snapshot, 1), /INTEGRITY_FAILURE/u);
    assert.equal(existsSync(join(projectionDirectory, "projections-2-1.sqlite")), false);
    snapshot.close();
    source.close();
  });

  it("rejects a final authentication cursor that differs from the captured terminal", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-terminal-cursor-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const source = createSource(sourcePath);
    insertEvent(source, 1);
    const snapshot = streamingSnapshot(await new SqliteProjectionEventReader({
      driver: terminalTamperingDriver(),
      eventStorePath: sourcePath,
    }).openCommittedSnapshot(BINDING));

    assert.throws(() => [...snapshot.events()], /INTEGRITY_FAILURE/u);
    snapshot.close();
    source.close();
  });

  it("rejects a generation whose persisted rows no longer match its intended core checksums", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-persisted-checksum-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const source = createSource(sourcePath);
    insertEvent(source, 1, "MemorySourceRecorded", memoryPayload());
    const driver = new RecordingDriver((connection) => {
      connection.prepare(`
        UPDATE canonical_items SET summary = 'tampered after insert'
      `).run();
    });
    const snapshot = await new SqliteProjectionEventReader({
      driver,
      eventStorePath: sourcePath,
    }).openCommittedSnapshot(BINDING);
    const builder = new ImmutableProjectionBuilder({
      driver,
      projectionDirectory: join(root, "projections"),
      now: () => NOW,
    });

    await assert.rejects(
      () => builder.buildV2(snapshot, 1),
      /PROJECTION_CHECKSUM_INVALID/u,
    );
    snapshot.close();
    source.close();
  });

  it("runs the FTS external-content integrity check before publishing a generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-fts-integrity-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const source = createSource(sourcePath);
    insertEvent(source, 1, "MemorySourceRecorded", memoryPayload());
    const driver = new RecordingDriver((connection) => {
      const row = connection.prepare(`
        SELECT row_id, normalized_key, text FROM lexical_chunks LIMIT 1
      `).get();
      assert.notEqual(row, undefined);
      connection.prepare(`
        INSERT INTO lexical_chunks_fts(
          lexical_chunks_fts, rowid, normalized_key, text
        ) VALUES ('delete', $rowId, $normalizedKey, $text)
      `).run({
        $rowId: row!.row_id!,
        $normalizedKey: row!.normalized_key!,
        $text: row!.text!,
      });
    });
    const snapshot = await new SqliteProjectionEventReader({
      driver,
      eventStorePath: sourcePath,
    }).openCommittedSnapshot(BINDING);
    const builder = new ImmutableProjectionBuilder({
      driver,
      projectionDirectory: join(root, "projections"),
      now: () => NOW,
    });

    await assert.rejects(
      () => builder.buildV2(snapshot, 1),
      /PROJECTION_FTS_INVALID/u,
    );
    snapshot.close();
    source.close();
  });

  it("refuses a post-close WAL sidecar before the durable generation rename", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-builder-sidecar-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = createSource(sourcePath);
    insertEvent(source, 1, "MemorySourceRecorded", memoryPayload());
    const driver = new RecordingDriver(undefined, (path) => {
      writeFileSync(`${path}-wal`, "unexpected post-close WAL", "utf8");
    });
    const snapshot = await new SqliteProjectionEventReader({
      driver,
      eventStorePath: sourcePath,
    }).openCommittedSnapshot(BINDING);
    const builder = new ImmutableProjectionBuilder({
      driver,
      projectionDirectory,
      now: () => NOW,
    });

    await assert.rejects(
      () => builder.buildV2(snapshot, 1),
      /INTEGRITY_FAILURE/u,
    );
    assert.equal(existsSync(join(projectionDirectory, "projections-2-1.sqlite")), false);
    snapshot.close();
    source.close();
  });
});
